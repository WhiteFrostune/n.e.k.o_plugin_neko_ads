"""Exit guarantees; no GUI, network or running host is needed."""

import uuid

from plugin.plugins.neko_ads import NekoAdsPlugin
from plugin.plugins.neko_ads.session import AdSession


def test_start_requires_confirmation_and_running_plugin():
    session = AdSession()
    rid = str(uuid.uuid4())
    assert not session.start(rid, True, session.snapshot()["epoch"])["active"]
    session.ready()
    assert not session.start(rid, False, session.snapshot()["epoch"])["active"]
    assert not session.start("bad-id", True, session.snapshot()["epoch"])["active"]
    assert session.start(rid, True, session.snapshot()["epoch"])["active"]


def test_stop_before_delayed_start_and_heartbeat_cannot_revive():
    session = AdSession()
    session.ready()
    rid = str(uuid.uuid4())
    session.stop(rid)
    assert not session.start(rid, True, session.snapshot()["epoch"])["active"]
    assert not session.heartbeat(rid)["active"]


def test_stale_stop_cannot_end_new_round():
    session = AdSession()
    session.ready()
    old, new = str(uuid.uuid4()), str(uuid.uuid4())
    session.start(old, True, session.snapshot()["epoch"])
    session.stop(old)
    assert session.start(new, True, session.snapshot()["epoch"])["active"]
    session.stop(old)
    assert session.heartbeat(new)["active"]


def test_second_page_cannot_take_over_active_round():
    session = AdSession()
    session.ready()
    first, second = str(uuid.uuid4()), str(uuid.uuid4())
    assert session.start(first, True, session.snapshot()["epoch"])["active"]
    assert not session.start(second, True, session.snapshot()["epoch"])["active"]
    assert session.heartbeat(first)["active"]


def test_lease_expiry_shutdown_and_manual_stop():
    time = [0.0]
    session = AdSession(clock=lambda: time[0])
    session.ready()
    rid = str(uuid.uuid4())
    session.start(rid, True, session.snapshot()["epoch"])
    time[0] = 9
    assert not session.heartbeat(rid)["active"]
    assert not session.start(rid, True, session.snapshot()["epoch"])["active"]
    rid = str(uuid.uuid4())
    session.start(rid, True, session.snapshot()["epoch"])
    session.shutdown()
    assert not session.snapshot()["ready"]
    assert not session.heartbeat(rid)["active"]
    session.ready()
    assert not session.start(rid, True, session.snapshot()["epoch"])["active"]
    session.start(str(uuid.uuid4()), True, session.snapshot()["epoch"])
    session.stop()
    assert not session.snapshot()["active"]


def test_sdk_lifecycle_and_ui_contract():
    # Exercise real decorated entry methods without opening host IPC.
    plugin = object.__new__(NekoAdsPlugin)
    plugin.session = AdSession()
    plugin.register_static_ui = lambda *args, **kwargs: True
    assert plugin.on_startup().is_ok()
    rid = str(uuid.uuid4())
    assert plugin.start_game(round_id=rid, confirmed=True, epoch=plugin.dashboard()["epoch"]).value["active"]
    assert plugin.heartbeat(round_id=rid).value["active"]
    assert plugin.on_freeze().is_ok()
    assert not plugin.heartbeat(round_id=rid).value["active"]
    plugin.on_unfreeze()
    assert plugin.start_game(round_id=str(uuid.uuid4()), confirmed=True, epoch=plugin.dashboard()["epoch"]).value["active"]
    plugin.stop_game()
    assert not plugin.dashboard()["active"]
    plugin.on_shutdown()
    assert not plugin.dashboard()["ready"]


def test_manual_stop_invalidates_start_still_in_flight():
    session = AdSession()
    session.ready()
    old_epoch = session.snapshot()["epoch"]
    session.stop()
    assert not session.start(str(uuid.uuid4()), True, old_epoch)["active"]
    assert session.start(str(uuid.uuid4()), True, session.snapshot()["epoch"])["active"]
