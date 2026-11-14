"""A round-scoped Windows hotkey. No keyboard hooks or input recording."""
from __future__ import annotations

import ctypes
import logging
import re
import sys
import threading
from ctypes import wintypes

DEFAULT_SHORTCUT = "Ctrl+Shift+1"
_LOG = logging.getLogger(__name__)
_WM_HOTKEY, _WM_QUIT = 0x0312, 0x0012
_WAIT_OBJECT_0, _WAIT_TIMEOUT = 0, 0x0102
_QS_ALLINPUT, _MWMO_INPUTAVAILABLE = 0x04FF, 0x0004
_PM_REMOVE, _MOD_NOREPEAT = 0x0001, 0x4000


def parse_shortcut(value: str) -> tuple[str, int, int]:
    parts = str(value).replace(" ", "").split("+")
    mods = parts[:-1]
    key = parts[-1].upper()
    if len(mods) < 1 or len(set(mods)) != len(mods) or any(m not in {"Ctrl", "Alt", "Shift"} for m in mods):
        raise ValueError("请使用 Ctrl、Alt、Shift 与一个字母、数字或 F1–F11 组合")
    if re.fullmatch(r"[A-Z0-9]", key):
        vk = ord(key)
    elif re.fullmatch(r"F(?:[1-9]|10|11)", key):
        vk = 0x70 + int(key[1:]) - 1
    else:
        raise ValueError("不支持这个退出按键")
    ordered = [m for m in ("Ctrl", "Alt", "Shift") if m in mods]
    return "+".join([*ordered, key]), sum({"Ctrl": 2, "Alt": 1, "Shift": 4}[m] for m in mods), vk


class GlobalExitHotkey:
    def __init__(self):
        self.thread = None
        self.thread_id = None
        self._user32 = None
        self._closing = threading.Event()
        self._lock = threading.Lock()
        self._stop_signal = None

    def register(self, shortcut: str, callback) -> str:
        label, mods, vk = parse_shortcut(shortcut)
        if sys.platform != "win32":
            raise ValueError("此平台尚未接入全局退出快捷键，不能开始桌宠广告游戏")
        ready = threading.Event()
        result = {"ok": False}

        def run():
            registered, handle = False, None
            try:
                user32 = ctypes.WinDLL("user32", use_last_error=True)
                kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
                user32.RegisterHotKey.argtypes = [wintypes.HWND, ctypes.c_int, wintypes.UINT, wintypes.UINT]
                user32.RegisterHotKey.restype = wintypes.BOOL
                user32.UnregisterHotKey.argtypes = [wintypes.HWND, ctypes.c_int]
                user32.UnregisterHotKey.restype = wintypes.BOOL
                user32.PeekMessageW.argtypes = [ctypes.POINTER(wintypes.MSG), wintypes.HWND, wintypes.UINT, wintypes.UINT, wintypes.UINT]
                user32.PeekMessageW.restype = wintypes.BOOL
                user32.MsgWaitForMultipleObjectsEx.argtypes = [wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE), wintypes.DWORD, wintypes.DWORD, wintypes.DWORD]
                user32.MsgWaitForMultipleObjectsEx.restype = wintypes.DWORD
                kernel32.GetCurrentThreadId.restype = wintypes.DWORD
                kernel32.CreateEventW.argtypes = [wintypes.LPVOID, wintypes.BOOL, wintypes.BOOL, wintypes.LPCWSTR]
                kernel32.CreateEventW.restype = wintypes.HANDLE
                kernel32.SetEvent.argtypes = kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
                kernel32.SetEvent.restype = kernel32.CloseHandle.restype = wintypes.BOOL
                handle = kernel32.CreateEventW(None, True, False, None)
                if not handle:
                    raise ctypes.WinError(ctypes.get_last_error())
                with self._lock:
                    if self._closing.is_set():
                        return
                    self._stop_signal = (kernel32, handle)
                    self._user32 = user32
                    self.thread_id = kernel32.GetCurrentThreadId()

                msg = wintypes.MSG()
                user32.PeekMessageW(ctypes.byref(msg), None, 0, 0, 0)
                if self._closing.is_set():
                    return
                registered = bool(user32.RegisterHotKey(None, 1, mods | _MOD_NOREPEAT, vk))
                result["ok"] = registered
                ready.set()
                if not registered:
                    return

                handles = (wintypes.HANDLE * 1)(handle)
                while not self._closing.is_set():
                    # The event wakes an idle worker immediately. The finite wait
                    # also observes _closing if Windows rejects the signal.
                    wake = user32.MsgWaitForMultipleObjectsEx(1, handles, 250, _QS_ALLINPUT, _MWMO_INPUTAVAILABLE)
                    if wake == _WAIT_OBJECT_0:
                        return
                    if wake == _WAIT_TIMEOUT:
                        continue
                    if wake != _WAIT_OBJECT_0 + 1:
                        raise ctypes.WinError(ctypes.get_last_error())
                    while not self._closing.is_set() and user32.PeekMessageW(ctypes.byref(msg), None, 0, 0, _PM_REMOVE):
                        if msg.message == _WM_QUIT:
                            return
                        if msg.message == _WM_HOTKEY and msg.wParam == 1 and not self._closing.is_set():
                            callback()
            except Exception:
                _LOG.exception("Windows exit hotkey worker failed")
            finally:
                if registered and not user32.UnregisterHotKey(None, 1):
                    _LOG.warning("Windows exit hotkey unregister failed: %s", ctypes.get_last_error())
                with self._lock:
                    self._stop_signal = None
                    if handle and not kernel32.CloseHandle(handle):
                        _LOG.warning("Windows exit hotkey event close failed: %s", ctypes.get_last_error())
                ready.set()

        with self._lock:
            if self.thread is not None or self._closing.is_set():
                raise ValueError("退出快捷键注册已取消或已开始")
            self.thread = threading.Thread(target=run, name="neko-ads-exit", daemon=True)
            self.thread.start()
        if not ready.wait(2) or not result["ok"] or self._closing.is_set():
            self.close()
            raise ValueError("退出快捷键不可用或已被占用，请换一个组合")
        return label

    def close(self):
        with self._lock:
            self._closing.set()
            thread = self.thread
            if self._stop_signal:
                kernel32, handle = self._stop_signal
                if not kernel32.SetEvent(handle):
                    _LOG.warning("Windows exit hotkey stop signal failed: %s", ctypes.get_last_error())
        if thread is None or thread is threading.current_thread():
            return
        thread.join(timeout=1)
        if thread.is_alive():
            _LOG.warning("Windows exit hotkey worker has not stopped; keeping its thread reference")
            return
        with self._lock:
            self.thread = self.thread_id = self._user32 = None
