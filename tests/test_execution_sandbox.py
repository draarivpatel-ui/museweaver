"""Actual headless browser tests using a disposable, unsigned-in profile."""
import functools
import http.server
import threading
from pathlib import Path

import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    paths = []
    def do_GET(self):
        self.paths.append(self.path)
        super().do_GET()

    def log_message(self, *args):
        pass


@pytest.fixture(scope="module")
def page():
    handler = functools.partial(QuietHandler, directory=str(ROOT))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    with sync_playwright() as playwright:
        chrome = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
        browser = playwright.chromium.launch(headless=True,
            executable_path=str(chrome) if chrome.exists() else None,
            args=["--disable-background-networking", "--no-first-run"])
        context = browser.new_context()
        context.route("**/*", lambda route: route.continue_() if route.request.url.startswith("http://127.0.0.1:")
                      else route.abort())
        page = context.new_page()
        page.goto(f"http://127.0.0.1:{server.server_port}/index.html")
        yield page
        context.close()
        browser.close()
    server.shutdown()
    server.server_close()
    thread.join(timeout=2)


def test_worker_has_no_host_dom_or_storage(page):
    result = page.evaluate("""() => runCustomCode(
        'assert(typeof document === "undefined"); assert(typeof localStorage === "undefined");'
        + 'assert(typeof parent === "undefined");', [])""")
    assert result["error"] is None
    assert len(result["assertions"]) == 3
    assert all(a["pass"] for a in result["assertions"])
    assert page.locator("iframe").count() == 0


def test_worker_cannot_open_external_socket(page):
    origin = page.url.split("/index.html")[0]
    before = len(QuietHandler.paths)
    code = ('let denied=false; try { await fetch(' + repr(origin + "/sandbox-network-canary") +
            '); } catch(e) { denied=true; } assert(denied, "network CSP enforced");')
    result = page.evaluate("code => runCustomCode(code, [])", code)
    assert result["error"] is None
    assert result["assertions"][0]["pass"]
    assert "/sandbox-network-canary" not in QuietHandler.paths[before:]


def test_infinite_loop_is_terminated_without_freezing_host(page):
    result = page.evaluate("() => runCustomCode('while(true) {}', [], 350)")
    assert result["error"] == "Execution timed out"
    assert float(result["elapsed"]) < 2500
    assert page.evaluate("1 + 1") == 2
    assert page.locator("iframe").count() == 0


def test_provided_tests_execute_and_exceptions_preserve_observations(page):
    result = page.evaluate("""() => runCustomCode(
        'const value=7;', ['assert(value === 7, "supplied test"); throw Error("expected failure");'])""")
    assert result["assertions"][0]["pass"]
    assert result["error"] == "expected failure"
