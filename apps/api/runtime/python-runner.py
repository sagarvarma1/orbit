"""Orbit's Python function runtime, modeled on Vercel's.

One process (or sandbox container) per function instance, serving one request at a time over
HTTP on a unix socket. The module is imported at startup (the cold start) and stays loaded while
the instance is warm.

    python3 python-runner.py <api/handler.py> <socket>

The entrypoint exposes one of, as on Vercel:
    handler = class(BaseHTTPRequestHandler)   with do_GET / do_POST / ...
    app = <WSGI application>                  Flask, Django, ...
    app = <ASGI application>                  FastAPI, Starlette, ...

Dependencies installed from requirements.txt live in <function root>/.orbit/python. An uncaught
error is answered with a 500 carrying x-orbit-error, then the instance exits.
"""

import asyncio
import base64
import importlib
import inspect
import io
import os
import socketserver
import sys
import traceback
from http.server import BaseHTTPRequestHandler
from urllib.parse import unquote

ENTRY, SOCKET = sys.argv[1], sys.argv[2]
ROOT = os.getcwd()
PACKAGES = os.path.join(ROOT, ".orbit", "python")
INTERNAL_HEADERS = ("x-orbit-params",)

# Imports resolve from the project root (`from api._lib import db`), then the installed
# requirements, then next to the entrypoint (`from _lib import db`). Requirements come before the
# entrypoint's directory, so api/flask.py can still `import flask`.
sys.path[0:0] = [p for p in (ROOT, PACKAGES, os.path.dirname(os.path.abspath(ENTRY))) if p not in sys.path]


def fatal_response(wfile, err):
    traceback.print_exception(err)
    message = base64.b64encode(str(err).encode()).decode()
    try:
        wfile.write(
            b"HTTP/1.1 500 Internal Server Error\r\n"
            + f"x-orbit-error: {message}\r\n".encode()
            + b"content-length: 0\r\nconnection: close\r\n\r\n"
        )
        wfile.flush()
    except OSError:
        pass
    sys.stderr.flush()
    os._exit(1)


def load():
    rel = os.path.relpath(os.path.abspath(ENTRY), ROOT)
    name = rel[:-3].replace(os.sep, ".") if rel.endswith(".py") else rel
    try:
        return importlib.import_module(name)
    except ImportError as err:
        # Not importable as a package path (e.g. an odd file name): load it from its location.
        if getattr(err, "name", None) not in (name, name.split(".")[0]):
            raise
        spec = importlib.util.spec_from_file_location("orbit_entry", ENTRY)
        module = importlib.util.module_from_spec(spec)
        sys.modules["orbit_entry"] = module
        spec.loader.exec_module(module)
        return module


def is_asgi(app):
    call = app if inspect.isfunction(app) or inspect.ismethod(app) else getattr(app, "__call__", None)
    if call is None:
        return False
    if inspect.iscoroutinefunction(call):
        return True
    try:
        return len(inspect.signature(call).parameters) == 3
    except (TypeError, ValueError):
        return False


class Base(BaseHTTPRequestHandler):
    """Unix sockets have no client address; keep BaseHTTPRequestHandler's logging working."""

    protocol_version = "HTTP/1.1"

    def address_string(self):
        return "-"

    def log_message(self, format, *args):
        pass  # the edge logs requests

    def read_body(self):
        length = int(self.headers.get("content-length") or 0)
        return self.rfile.read(length) if length else b""

    def clean_headers(self):
        for h in INTERNAL_HEADERS:
            del self.headers[h]


def handler_class(user):
    class Handler(Base, user):
        def handle_one_request(self):
            try:
                user.handle_one_request(self)
            except Exception as err:  # noqa: BLE001
                fatal_response(self.wfile, err)

        def parse_request(self):
            ok = super().parse_request()
            if ok:
                self.clean_headers()
            return ok

    return Handler


def wsgi_class(app):
    class Handler(Base):
        def handle_one_request(self):
            self.raw_requestline = self.rfile.readline(65537)
            if not self.raw_requestline or not self.parse_request():
                return
            self.clean_headers()
            self.close_connection = True
            try:
                self.run()
            except Exception as err:  # noqa: BLE001
                fatal_response(self.wfile, err)

        def run(self):
            body = self.read_body()
            path, _, query = self.path.partition("?")
            host = self.headers.get("x-forwarded-host") or self.headers.get("host") or "localhost"
            scheme = self.headers.get("x-forwarded-proto") or "https"
            server_name, _, port = host.partition(":")
            environ = {
                "REQUEST_METHOD": self.command,
                "SCRIPT_NAME": "",
                "PATH_INFO": unquote(path, "latin-1"),
                "QUERY_STRING": query,
                "SERVER_NAME": server_name,
                "SERVER_PORT": port or ("443" if scheme == "https" else "80"),
                "SERVER_PROTOCOL": "HTTP/1.1",
                "REMOTE_ADDR": (self.headers.get("x-forwarded-for") or "").split(",")[0].strip(),
                "CONTENT_LENGTH": str(len(body)),
                "wsgi.version": (1, 0),
                "wsgi.url_scheme": scheme,
                "wsgi.input": io.BytesIO(body),
                "wsgi.errors": sys.stderr,
                "wsgi.multithread": False,
                "wsgi.multiprocess": True,
                "wsgi.run_once": False,
            }
            if self.headers.get("content-type"):
                environ["CONTENT_TYPE"] = self.headers["content-type"]
            for key, value in self.headers.items():
                name = "HTTP_" + key.upper().replace("-", "_")
                if name in ("HTTP_CONTENT_TYPE", "HTTP_CONTENT_LENGTH"):
                    continue
                environ[name] = f"{environ[name]},{value}" if name in environ else value

            state = {}
            chunks = []

            def start_response(status, headers, exc_info=None):
                if exc_info and state.get("sent"):
                    raise exc_info[1].with_traceback(exc_info[2])
                state["status"], state["headers"] = status, headers
                return chunks.append

            result = app(environ, start_response)
            try:
                for chunk in result:
                    if chunk:
                        chunks.append(chunk)
            finally:
                if hasattr(result, "close"):
                    result.close()
            payload = b"".join(chunks)
            code, _, reason = state["status"].partition(" ")
            self.send_response(int(code), reason or None)
            for key, value in state["headers"]:
                if key.lower() not in ("content-length", "connection", "transfer-encoding"):
                    self.send_header(key, value)
            self.send_header("content-length", str(len(payload)))
            self.send_header("connection", "close")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(payload)

    return Handler


def asgi_class(app):
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    lifespan = {"state": {}}

    async def startup():
        queue = asyncio.Queue()
        await queue.put({"type": "lifespan.startup"})
        done = loop.create_future()

        async def receive():
            return await queue.get()

        async def send(message):
            if message["type"] in ("lifespan.startup.complete", "lifespan.startup.failed") and not done.done():
                done.set_result(message)

        task = loop.create_task(app({"type": "lifespan", "asgi": {"version": "3.0"}, "state": lifespan["state"]}, receive, send))
        finished = await asyncio.wait({task, done}, return_when=asyncio.FIRST_COMPLETED)
        if done in finished[0] and done.result()["type"] == "lifespan.startup.failed":
            raise RuntimeError(done.result().get("message") or "ASGI lifespan startup failed")
        # An app without lifespan support raises or returns; that's fine.

    try:
        loop.run_until_complete(startup())
    except RuntimeError:
        raise
    except Exception:  # noqa: BLE001
        pass

    class Handler(Base):
        def handle_one_request(self):
            self.raw_requestline = self.rfile.readline(65537)
            if not self.raw_requestline or not self.parse_request():
                return
            self.clean_headers()
            self.close_connection = True
            try:
                loop.run_until_complete(self.run())
            except Exception as err:  # noqa: BLE001
                fatal_response(self.wfile, err)

        async def run(self):
            body = self.read_body()
            path, _, query = self.path.partition("?")
            host = self.headers.get("x-forwarded-host") or self.headers.get("host") or "localhost"
            scheme = self.headers.get("x-forwarded-proto") or "https"
            server_name, _, port = host.partition(":")
            scope = {
                "type": "http",
                "asgi": {"version": "3.0", "spec_version": "2.3"},
                "http_version": "1.1",
                "method": self.command,
                "scheme": scheme,
                "path": unquote(path),
                "raw_path": path.encode(),
                "query_string": query.encode(),
                "root_path": "",
                "headers": [(k.lower().encode("latin-1"), v.encode("latin-1")) for k, v in self.headers.items()],
                "client": None,
                "server": (server_name, int(port) if port else (443 if scheme == "https" else 80)),
                "state": dict(lifespan["state"]),
            }
            sent_body = asyncio.Event()
            messages = [{"type": "http.request", "body": body, "more_body": False}]
            response = {"status": 500, "headers": [], "chunks": []}

            async def receive():
                if messages:
                    return messages.pop(0)
                await sent_body.wait()
                return {"type": "http.disconnect"}

            async def send(message):
                if message["type"] == "http.response.start":
                    response["status"] = message["status"]
                    response["headers"] = message.get("headers", [])
                elif message["type"] == "http.response.body":
                    response["chunks"].append(message.get("body", b""))
                    if not message.get("more_body"):
                        sent_body.set()

            await app(scope, receive, send)
            payload = b"".join(response["chunks"])
            self.send_response(response["status"])
            for key, value in response["headers"]:
                k = key.decode("latin-1") if isinstance(key, bytes) else key
                v = value.decode("latin-1") if isinstance(value, bytes) else value
                if k.lower() not in ("content-length", "connection", "transfer-encoding"):
                    self.send_header(k, v)
            self.send_header("content-length", str(len(payload)))
            self.send_header("connection", "close")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(payload)

    return Handler


class Server(socketserver.UnixStreamServer):
    def handle_error(self, request, client_address):
        traceback.print_exc()


def main():
    try:
        module = load()
    except BaseException:  # noqa: BLE001
        traceback.print_exc()
        sys.stderr.flush()
        os._exit(1)

    user = getattr(module, "handler", None)
    if inspect.isclass(user) and issubclass(user, BaseHTTPRequestHandler):
        cls = handler_class(user)
    else:
        app = next(
            (getattr(module, n) for n in ("app", "application", "handler") if callable(getattr(module, n, None))),
            None,
        )
        if app is None:
            print(
                "No handler found: export `handler` (a BaseHTTPRequestHandler subclass) or `app` (WSGI or ASGI)",
                file=sys.stderr,
            )
            sys.stderr.flush()
            os._exit(1)
        cls = asgi_class(app) if is_asgi(app) else wsgi_class(app)

    with Server(SOCKET, cls) as server:
        server.serve_forever()


if __name__ == "__main__":
    main()
