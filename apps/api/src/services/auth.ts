import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { ApiToken, GitHubProfile, GitHubUserToken, Repo, User, UserRole } from "../db/repo.js";
import { BadRequestError, HttpError } from "../lib/errors.js";
import { newId, randomId } from "../lib/ids.js";

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number, options: object) => Promise<Buffer>;

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SESSION_DAYS = 30;
export const SESSION_COOKIE = "orbit_session";
export const API_TOKEN_PREFIX = "orbit_";
export const MIN_PASSWORD_LENGTH = 10;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !n || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = await scryptAsync(password, Buffer.from(salt, "base64"), expected.length, { ...SCRYPT, N: Number(n) });
  return timingSafeEqual(actual, expected);
}

/** Session and API tokens are random; only their SHA-256 is stored. */
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export class UnauthorizedError extends HttpError {
  constructor(message = "Sign in to continue") {
    super(401, message);
  }
}

export class ForbiddenError extends HttpError {
  constructor(message: string) {
    super(403, message);
  }
}

export interface PublicUser {
  id: string;
  email: string;
  role: UserRole;
  githubLogin: string | null;
  name: string | null;
  avatarUrl: string | null;
  /** Whether the account can sign in with a password (the original admin). */
  hasPassword: boolean;
}

export const publicUser = (u: User): PublicUser => ({
  id: u.id,
  email: u.email,
  role: u.role,
  githubLogin: u.githubLogin,
  name: u.name,
  avatarUrl: u.avatarUrl,
  hasPassword: Boolean(u.passwordHash),
});

export interface GitHubSignInOptions {
  /** Anyone may create an account; otherwise only existing users and the admin. */
  signups: boolean;
  /** Lower-case GitHub login of the instance admin, if known. */
  adminLogin: string | null;
}

function normalizeEmail(email: string): string {
  const value = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(value)) throw new BadRequestError("Enter a valid email address");
  return value;
}

function checkPassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH)
    throw new BadRequestError(`Passwords need at least ${MIN_PASSWORD_LENGTH} characters`);
}

/**
 * Accounts. The first (admin) account is created with a one-time setup code that is printed in
 * the control plane's logs, so nobody who merely finds a fresh instance on the internet can claim
 * it. Once a GitHub App is connected, people sign in with GitHub instead.
 */
export class AuthService {
  /** null once an admin exists. */
  private setupCode: string | null = null;
  /** Failed sign-in attempts per client, for basic brute-force protection. */
  private readonly failures = new Map<string, { count: number; until: number }>();

  constructor(private readonly repo: Repo) {}

  get setupRequired(): boolean {
    return this.repo.countUsers() === 0;
  }

  /** Called on boot. Returns the code to print, or null if an admin already exists. */
  async init(seed?: { email?: string; password?: string; resetPassword?: string }): Promise<string | null> {
    if (!this.setupRequired) {
      // Recovery path for a forgotten password: whoever controls the server's env controls Orbit anyway.
      if (seed?.resetPassword) {
        checkPassword(seed.resetPassword);
        const admin = this.repo.firstUser()!;
        this.repo.updateUserPassword(admin.id, await hashPassword(seed.resetPassword));
        this.repo.deleteUserSessions(admin.id);
        console.log(`Password reset for ${admin.email}. Remove ORBIT_RESET_ADMIN_PASSWORD and restart.`);
      }
      return null;
    }
    if (seed?.email && seed.password) {
      await this.createUser(seed.email, seed.password, "admin");
      return null;
    }
    this.setupCode = `${randomId(4)}-${randomId(4)}`.toUpperCase();
    return this.setupCode;
  }

  async setup(code: string, email: string, password: string): Promise<{ user: PublicUser; session: string }> {
    if (!this.setupRequired || !this.setupCode) throw new HttpError(409, "Orbit is already set up. Sign in instead.");
    const given = Buffer.from(code.trim().toUpperCase());
    const expected = Buffer.from(this.setupCode);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new BadRequestError("That setup code is not right. It's printed in the Orbit API logs.");
    }
    const user = await this.createUser(email, password, "admin");
    this.setupCode = null;
    return { user: publicUser(user), session: this.createSession(user.id) };
  }

  async login(email: string, password: string, client: string): Promise<{ user: PublicUser; session: string }> {
    const blocked = this.failures.get(client);
    if (blocked && blocked.count >= 5 && blocked.until > Date.now()) {
      throw new HttpError(429, "Too many attempts. Try again in a minute.");
    }
    const user = this.repo.getUserByEmail(email.trim().toLowerCase());
    // Hash even for unknown emails so timing doesn't reveal which accounts exist.
    const ok = await verifyPassword(password, user?.passwordHash ?? "scrypt$16384$AAAAAAAAAAAAAAAAAAAAAA==$AAAA");
    if (!user || !ok) {
      const count = blocked && blocked.until > Date.now() ? blocked.count + 1 : 1;
      this.failures.set(client, { count, until: Date.now() + 60_000 });
      throw new UnauthorizedError("Wrong email or password");
    }
    this.failures.delete(client);
    return { user: publicUser(user), session: this.createSession(user.id) };
  }

  /**
   * Signs in (or signs up) with a GitHub identity. The admin's GitHub account takes over the
   * original password-based admin account the first time, so existing projects carry over.
   */
  signInWithGithub(
    profile: GitHubProfile & { email: string | null },
    token: GitHubUserToken,
    opts: GitHubSignInOptions,
  ): { user: PublicUser; session: string; created: boolean } {
    let user = this.repo.getUserByGithubId(profile.githubId);
    let created = false;
    if (!user) {
      const isAdmin = opts.adminLogin !== null && profile.githubLogin.toLowerCase() === opts.adminLogin;
      const unlinked = isAdmin ? this.repo.unlinkedAdmin() : undefined;
      if (unlinked) {
        user = unlinked;
      } else {
        if (!isAdmin && !opts.signups) {
          throw new ForbiddenError("Sign-ups are closed on this Orbit instance. Ask its admin for access.");
        }
        // GitHub only shares public emails; fall back to the no-reply address GitHub assigns everyone.
        const noreply = `${profile.githubId}+${profile.githubLogin}@users.noreply.github.com`.toLowerCase();
        const email = profile.email && !this.repo.getUserByEmail(profile.email.toLowerCase()) ? profile.email : noreply;
        user = {
          id: newId("usr"),
          email: email.toLowerCase(),
          passwordHash: "",
          role: isAdmin ? "admin" : "member",
          githubId: null,
          githubLogin: null,
          name: null,
          avatarUrl: null,
          githubToken: null,
          createdAt: Date.now(),
        };
        this.repo.insertUser(user);
        created = true;
      }
    }
    this.repo.updateUserGithub(user.id, profile, token);
    const fresh = this.repo.getUser(user.id)!;
    return { user: publicUser(fresh), session: this.createSession(fresh.id), created };
  }

  logout(session: string): void {
    this.repo.deleteSession(hashToken(session));
  }

  async changePassword(userId: string, current: string, next: string): Promise<string> {
    const user = this.repo.getUser(userId);
    if (user && !user.passwordHash) throw new BadRequestError("This account signs in with GitHub and has no password");
    if (!user || !(await verifyPassword(current, user.passwordHash))) throw new BadRequestError("Current password is wrong");
    checkPassword(next);
    this.repo.updateUserPassword(user.id, await hashPassword(next));
    // Sign out everywhere else.
    this.repo.deleteUserSessions(user.id);
    return this.createSession(user.id);
  }

  /** Resolve a session cookie or `Authorization: Bearer orbit_…` token to a user. */
  authenticate(session: string | undefined, bearer: string | undefined): { user: PublicUser; via: "session" | "token" } | null {
    if (bearer?.startsWith(API_TOKEN_PREFIX)) {
      const user = this.repo.apiTokenUser(hashToken(bearer));
      return user ? { user: publicUser(user), via: "token" } : null;
    }
    if (session) {
      const user = this.repo.sessionUser(hashToken(session));
      return user ? { user: publicUser(user), via: "session" } : null;
    }
    return null;
  }

  createApiToken(userId: string, name: string): { token: string; apiToken: ApiToken } {
    const token = `${API_TOKEN_PREFIX}${randomBytes(24).toString("base64url")}`;
    const apiToken: ApiToken = {
      id: newId("tok"),
      userId,
      name: name.trim() || "Untitled",
      prefix: token.slice(0, API_TOKEN_PREFIX.length + 4),
      createdAt: Date.now(),
      lastUsedAt: null,
    };
    this.repo.insertApiToken({ ...apiToken, tokenHash: hashToken(token) });
    return { token, apiToken };
  }

  private async createUser(email: string, password: string, role: UserRole): Promise<User> {
    checkPassword(password);
    const user: User = {
      id: newId("usr"),
      email: normalizeEmail(email),
      passwordHash: await hashPassword(password),
      role,
      githubId: null,
      githubLogin: null,
      name: null,
      avatarUrl: null,
      githubToken: null,
      createdAt: Date.now(),
    };
    this.repo.insertUser(user);
    return user;
  }

  private createSession(userId: string): string {
    const token = randomBytes(32).toString("base64url");
    this.repo.insertSession(hashToken(token), userId, Date.now() + SESSION_DAYS * 86_400_000);
    return token;
  }
}

export const SESSION_MAX_AGE_SECONDS = SESSION_DAYS * 86_400;
