"""N.E.K.O SDK v2 plugin. All game presentation stays in its static UI."""

from plugin.sdk.plugin import NekoPluginBase, Ok, lifecycle, neko_plugin, plugin_entry, ui

from .session import AdSession


@neko_plugin
class NekoAdsPlugin(NekoPluginBase):
    def __init__(self, ctx):
        super().__init__(ctx)
        self.session = AdSession()

    @lifecycle(id="startup")
    def on_startup(self):
        if not self.register_static_ui("static", cache_control="no-store"):
            from plugin.sdk.plugin import Err, SdkError

            return Err(SdkError("猫娘广告部静态界面缺失"))
        self.session.ready()
        return Ok({"status": "ready"})

    @lifecycle(id="shutdown")
    def on_shutdown(self):
        return Ok(self.session.shutdown())

    @lifecycle(id="freeze")
    def on_freeze(self):
        return Ok(self.session.shutdown())

    @lifecycle(id="unfreeze")
    def on_unfreeze(self):
        self.session.ready()
        return Ok({"status": "ready"})

    @ui.context(id="main")
    def dashboard(self):
        return self.session.snapshot()

    @ui.action(label="确认开局", refresh_context=False)
    @plugin_entry(id="start_game", description="仅供用户在广告游戏界面确认后开局。")
    def start_game(self, round_id: str, epoch: str, confirmed: bool = False):
        return Ok(self.session.start(round_id, confirmed, epoch))

    @ui.action(label="检查本局", refresh_context=False)
    @plugin_entry(id="heartbeat", description="检查本局是否仍运行，不会恢复已结束的游戏。")
    def heartbeat(self, round_id: str):
        return Ok(self.session.heartbeat(round_id))

    @ui.action(label="立即结束", tone="danger", refresh_context=False)
    @plugin_entry(id="stop_game", description="立即结束广告游戏；不传 round_id 则结束当前局。")
    def stop_game(self, round_id: str = ""):
        return Ok(self.session.stop(round_id))
