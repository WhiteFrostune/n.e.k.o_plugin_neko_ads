import sys
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from plugin.plugins.neko_ads import hotkey

pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="Windows global key")
SHORTCUT = "Ctrl+Alt+Shift+F10"


def test_rejected_stop_signal_still_releases_the_native_key(monkeypatch, caplog):
    key = hotkey.GlobalExitHotkey()
    replacement = hotkey.GlobalExitHotkey()
    try:
        key.register(SHORTCUT, lambda: None)
        worker = key.thread
        kernel32, _ = key._stop_signal
        monkeypatch.setattr(kernel32, "SetEvent", lambda _: False)
        key.close()
        assert "stop signal failed" in caplog.text
        assert not worker.is_alive() and key.thread is None
        assert replacement.register(SHORTCUT, lambda: None) == SHORTCUT
    finally:
        key.close()
        replacement.close()


def test_close_during_registration_releases_the_late_native_key(monkeypatch):
    key = hotkey.GlobalExitHotkey()
    replacement = hotkey.GlobalExitHotkey()
    entered, release = threading.Event(), threading.Event()
    load = hotkey.ctypes.WinDLL

    def delayed_user32(name, **kwargs):
        dll = load(name, **kwargs)
        if name == "user32":
            native_register = dll.RegisterHotKey

            def register_late(*args):
                entered.set()
                if not release.wait(5):
                    raise TimeoutError("test did not release delayed registration")
                return native_register(*args)

            dll.RegisterHotKey = register_late
        return dll

    try:
        with monkeypatch.context() as patch, ThreadPoolExecutor(2) as pool:
            patch.setattr(hotkey.ctypes, "WinDLL", delayed_user32)
            registering = pool.submit(key.register, SHORTCUT, lambda: None)
            try:
                assert entered.wait(1)
                worker = key.thread
                closing = pool.submit(key.close)
                assert key._closing.wait(1)
            finally:
                release.set()
            closing.result(timeout=2)
            with pytest.raises(ValueError, match="退出快捷键不可用"):
                registering.result(timeout=2)
            assert not worker.is_alive() and key.thread is None
        assert replacement.register(SHORTCUT, lambda: None) == SHORTCUT
    finally:
        key.close()
        replacement.close()
