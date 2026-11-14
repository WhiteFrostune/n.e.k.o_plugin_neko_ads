"""Plugin-owned rounds for the opt-in desktop renderer bridge."""
from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass, field

from .connection import CONNECTION_POLICY, LEASE_SECONDS
from .hotkey import DEFAULT_SHORTCUT, GlobalExitHotkey, parse_shortcut

LINES = {
    'start': ('广告部，开业！', 'happy'),
    'fake': ('杂鱼杂鱼！', 'happy'),
    'dodge': ('这边啦！', 'happy'),
    'closed': ('算你赢！', 'angry'),
    'fakejp': ('ざこ、ざこ！', 'happy'),
    'dodgecatch': ('抓不到喵！', 'happy'),
    'closedfast': ('手挺快嘛！', 'surprised'),
    'fakeagain': ('又上当啦！', 'happy'),
    'dodgeslow': ('慢吞吞～', 'happy'),
    'closedagain': ('哼，再来！', 'angry'),
    'view': ('嘴上说要关掉，结果还是点进去了嘛～', 'happy'),
    'scan': ('体检完毕！主人需要补充一只猫娘♡', 'happy'),
    'split': ('关掉一张，赠送一张。是不是很贴心？', 'happy'),
    'later': ('稍后？本广告部的稍后，就是现在哦～', 'happy'),
    'streak': ('等、等等……你怎么越来越熟练了！不许笑！', 'surprised'),
}
BRIDGE_PROTOCOL = 1


def valid_id(value):
    try:
        uuid.UUID(value)
        return True
    except (ValueError, TypeError, AttributeError):
        return False


@dataclass
class SpeechJob:
    task: asyncio.Task | None = None
    chunks: list[bytes] = field(default_factory=list)
    streamed: bool = False
    playable: bool = True
    prepared: bytes | None = None
    offset: int = 0
    sample_rate: int | None = None

    def emit(self, data):
        if not self.playable:
            return
        self.streamed = True
        self.chunks.append(data)


class DesktopController:
    def __init__(self, session, hotkey_factory=GlobalExitHotkey, clock=time.monotonic, speech_factory=None, *, prepare_voices=True, identity_factory=None, voice_cache_dir=None):
        self.session, self.clock, self.hotkey_factory = session, clock, hotkey_factory
        self.speech_factory = speech_factory
        self.bridges = {}
        self.round_id = self.owner = self.character = None
        self.pending_round_id = None
        self.stop_epoch = str(uuid.uuid4())
        self.shortcut = DEFAULT_SHORTCUT
        self.hotkey = None
        self.generation = 0
        self.start_lock = asyncio.Lock()
        self.watchdog = None
        self.jobs = {}
        self.warming = {}
        self.speech_sequence = 0
        self.last_speech = float('-inf')
        self.voice_enabled = True
        self.bank = None
        self.next_voice_check = 0
        if prepare_voices:
            from .speech import current_voice_identity, synthesize_current
            from .voice import VoiceBank
            self.bank = VoiceBank(LINES, speech_factory or synthesize_current, identity_factory or current_voice_identity, cache_dir=voice_cache_dir)

    def snapshot(self):
        now = self.clock()
        self.bridges = {key: value for key, value in self.bridges.items() if now - value['seen'] < LEASE_SECONDS}
        bridge = max(self.bridges.values(), key=lambda value: value['seen'], default=None)
        session = self.session.snapshot()
        return {
            **session,
            'phase': 'disabled' if not session['ready'] else 'playing' if session['active'] else 'standby' if bridge else 'waiting',
            'round_id': self.round_id, 'owner': self.owner,
            'pending_round_id': self.pending_round_id, 'stop_epoch': self.stop_epoch,
            'character': self.character, 'shortcut': self.shortcut, 'safe_word': '广告下班',
            'voice_enabled': self.voice_enabled,
            'connection_policy': dict(CONNECTION_POLICY),
            'bridge_protocol': BRIDGE_PROTOCOL,
            'voice_preparation': self.bank.snapshot() if self.bank else None,
            'desktop_ready': bridge is not None,
            'desktop': {key: bridge[key] for key in ('client_id', 'character', 'bridge_version', 'bridge_protocol')} if bridge else None,
            'feedback': {key: {'text': value[0], 'emotion': value[1]} for key, value in LINES.items()},
        }

    def run(self):
        if self.watchdog is None or self.watchdog.done():
            self.watchdog = asyncio.create_task(self._watch())

    async def _watch(self):
        try:
            while True:
                await asyncio.sleep(.25)
                if self.round_id and not self.session.snapshot()['active']:
                    await self.stop(self.round_id)
                status = self.snapshot()
                if self.bank and status['ready'] and status['desktop']:
                    bridge = self.bridges.get(self.owner) if self.owner else max(self.bridges.values(), key=lambda item: item['seen'], default=None)
                    if bridge:
                        self.bank.set_busy(bridge.get('busy', False))
                        if self.clock() >= self.next_voice_check:
                            self.next_voice_check = self.clock() + 2
                            await self.bank.refresh(bridge['character'])
                        self.bank.ensure()
        except asyncio.CancelledError:
            pass

    async def close(self):
        await self.stop()
        if self.watchdog:
            self.watchdog.cancel()
            self.watchdog = None
        self.bridges.clear()

    async def poll(self, client_id, character, busy=False, bridge_version=None, round_id=None, bridge_protocol=None):
        if not valid_id(client_id) or not isinstance(character, str) or not character.strip() or len(character) > 120:
            raise ValueError('无效的主界面标识')
        # The SDK runs startup on a temporary event loop. The renderer's first
        # command attaches the watcher to the persistent command loop instead.
        self.run()
        version = bridge_version if isinstance(bridge_version, str) and len(bridge_version) <= 40 else None
        self.bridges[client_id] = {'client_id': client_id, 'character': character, 'seen': self.clock(),
                                   'busy': busy is True, 'bridge_version': version, 'bridge_protocol': bridge_protocol}
        if self.bank and (not self.owner or self.owner == client_id):
            self.bank.set_busy(busy is True)
            if self.bank.character != character:
                self.next_voice_check = 0
        if self.round_id and self.owner == client_id:
            if character != self.character or not self.session.snapshot()['active']:
                await self.stop(self.round_id)
            elif round_id == self.round_id:
                self.session.heartbeat(round_id)
        return self.snapshot()

    async def start(self, round_id, owner, confirmed, shortcut, voice_enabled=True, epoch=None, stop_epoch=None):
        async with self.start_lock:
            if confirmed is not True or not valid_id(round_id):
                raise ValueError('请先确认安全词和退出快捷键')
            status = self.snapshot()
            epoch = status['epoch'] if epoch is None else epoch
            if epoch != status['epoch'] or round_id in status['retired_round_ids'] or stop_epoch is not None and stop_epoch != self.stop_epoch:
                raise ValueError('本局已结束，请重新确认开局')
            bridge = self.bridges.get(owner)
            if not bridge:
                raise ValueError('主界面桥接尚未连接，请先重新加载猫娘主界面')
            if bridge['bridge_protocol'] not in (None, BRIDGE_PROTOCOL):
                raise ValueError('猫娘主界面的脚本版本与插件不兼容，请重新加载猫娘主界面')
            if status['active']:
                raise ValueError('广告游戏已经开启')
            version = self.generation
            self.pending_round_id = round_id
            loop = asyncio.get_running_loop()
            key = self.hotkey_factory()
            try:
                label = await asyncio.to_thread(key.register, shortcut,
                    lambda: asyncio.run_coroutine_threadsafe(self.stop(round_id), loop))
                if version != self.generation:
                    raise ValueError('开局已取消')
                result = self.session.start(round_id, True, epoch)
                if not result['active']:
                    raise ValueError('本局已结束，请重新确认开局')
                self.round_id, self.owner, self.character = round_id, owner, bridge['character']
                self.hotkey, self.shortcut = key, label
                self.voice_enabled = voice_enabled is True
                if self.bank:
                    self.bank.enable(self.voice_enabled)
                self.last_speech = float('-inf')
                self.speech_sequence = 0
                return self.snapshot()
            except BaseException:
                await asyncio.to_thread(key.close)
                self.session.stop(round_id)
                raise
            finally:
                if self.pending_round_id == round_id:
                    self.pending_round_id = None

    async def stop(self, round_id=None, *, epoch=None):
        if epoch is not None and epoch != self.stop_epoch:
            return {**self.snapshot(), 'stop_ignored': True}
        if round_id and round_id not in (self.round_id, self.pending_round_id):
            self.session.stop(round_id)
            return {**self.snapshot(), 'stopped_round_id': round_id}
        stopped_id = round_id or self.round_id or self.pending_round_id
        self.generation += 1
        self.session.stop(round_id or '')
        self.stop_epoch = str(uuid.uuid4())
        self.pending_round_id = None
        self.round_id = self.owner = self.character = None
        key, self.hotkey = self.hotkey, None
        self.cancel_speech()
        if self.bank:
            self.bank.pause()
        if key:
            await asyncio.to_thread(key.close)
        return {**self.snapshot(), 'stopped_round_id': stopped_id}

    async def change_shortcut(self, round_id, shortcut):
        if round_id != self.round_id or not self.session.snapshot()['active']:
            raise ValueError('本局已结束')
        label = parse_shortcut(shortcut)[0]
        if label == self.shortcut:
            return self.snapshot()
        loop = asyncio.get_running_loop()
        key = self.hotkey_factory()
        try:
            label = await asyncio.to_thread(key.register, label,
                lambda: asyncio.run_coroutine_threadsafe(self.stop(round_id), loop))
            if round_id != self.round_id:
                raise ValueError('本局已结束')
        except BaseException:
            await asyncio.to_thread(key.close)
            raise
        old, self.hotkey, self.shortcut = self.hotkey, key, label
        if old:
            await asyncio.to_thread(old.close)
        return self.snapshot()

    def _forget_warm(self, job_id, task):
        self.warming.pop(job_id, None)
        if not task.cancelled():
            task.exception()

    def cancel_speech(self, preserve=False):
        pending = {**self.jobs, **({} if preserve else self.warming)}
        if not preserve:
            self.warming.clear()
        for job_id, job in pending.items():
            task = job.task
            job.playable = False
            if not task.done():
                if preserve:
                    self.warming[job_id] = job
                    task.add_done_callback(lambda done, key=job_id: self._forget_warm(key, done))
                else:
                    task.cancel()
            elif not task.cancelled():
                task.exception()
            job.chunks.clear()
        self.jobs.clear()

    def speech(self, round_id, event, sequence=None):
        if round_id != self.round_id or not self.session.snapshot()['active'] or event not in LINES or not self.voice_enabled:
            return {}
        streaming = sequence is not None
        sequence = self.speech_sequence + 1 if sequence is None else sequence
        if type(sequence) is not int or sequence <= self.speech_sequence:
            return {}
        self.speech_sequence = sequence
        if self.bank:
            clip = self.bank.clip(event)
            if clip is None:
                self.bank.record(event, 'not_ready')
                return {'skipped':'not_ready'}
            self.cancel_speech()
            resource = self.bank.resource(event)
            if resource:
                self.bank.record(event, 'delivered')
                return {'audio_url':'/ui/voice-cache/' + resource, 'voice_token':self.bank.token}
            future = asyncio.get_running_loop().create_future()
            future.set_result(clip)
            job_id = str(uuid.uuid4())
            job = SpeechJob(task=future, prepared=clip[0])
            # Keep IPC replies bounded. Prepared PCM can start immediately,
            # without transporting a whole utterance in one host response.
            if clip[1] == 'audio/wav':
                import io
                import wave
                try:
                    with wave.open(io.BytesIO(clip[0]), 'rb') as wav:
                        if wav.getnchannels() == 1 and wav.getsampwidth() == 2 and wav.getcomptype() == 'NONE':
                            job.prepared = wav.readframes(wav.getnframes())
                            job.sample_rate = wav.getframerate()
                except (wave.Error, EOFError):
                    pass
            self.jobs[job_id] = job
            self.bank.record(event, 'delivered')
            return {'job_id':job_id, 'voice_token':self.bank.token}
        if self.clock() - self.last_speech < 2.2:
            return {}
        self.last_speech = self.clock()
        self.cancel_speech(preserve=True)
        if self.speech_factory is None:
            from .speech import synthesize_current
            factory = synthesize_current
        else:
            factory = self.speech_factory
        job_id = str(uuid.uuid4())
        job = SpeechJob()
        job.task = asyncio.create_task(factory(
            self.character, LINES[event][0], lambda: self.round_id == round_id and self.session.snapshot()['active'],
            emit=job.emit if streaming else None))
        self.jobs[job_id] = job
        return {'job_id': job_id}

    def speech_result(self, job_id):
        import base64
        job = self.jobs.get(job_id)
        if not job:
            return {'ready': True}
        if job.prepared is not None:
            end = min(job.offset + 48_000, len(job.prepared))
            part = base64.b64encode(job.prepared[job.offset:end]).decode('ascii')
            job.offset = end
            ready = end == len(job.prepared)
            if ready:
                self.jobs.pop(job_id, None)
            return {'ready':ready, **({'pcm':part, 'sample_rate':job.sample_rate} if job.sample_rate else {'audio_part':part})}
        task = job.task
        result = {'ready': task.done()}
        if job.chunks:
            result.update(pcm=base64.b64encode(b''.join(job.chunks)).decode('ascii'), sample_rate=48000)
            job.chunks.clear()
        if not task.done():
            return result
        self.jobs.pop(job_id, None)
        try:
            audio, mime = task.result()
            if not job.streamed and audio:
                result.update(audio=base64.b64encode(audio).decode('ascii'), mime=mime)
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            result['error'] = type(exc).__name__
        return result

    async def command(self, command, payload):
        if not isinstance(payload, dict):
            raise ValueError('无效请求')
        rid = payload.get('round_id')
        if command in ('start', 'shortcut', 'speech', 'cancel_speech') or (command in ('poll', 'stop') and rid is not None):
            if not valid_id(rid):
                raise ValueError('无效的游戏标识')
        if command in ('speech', 'voice_clip'):
            event = payload.get('event')
            if not isinstance(event, str) or event not in LINES:
                raise ValueError('无效的语音事件')
        if command in ('speech', 'cancel_speech'):
            sequence = payload.get('sequence')
            if sequence is not None and (type(sequence) is not int or not 0 <= sequence <= 2**53 - 1):
                raise ValueError('无效的语音操作序号')
        if command == 'poll':
            busy, version, protocol = payload.get('busy', False), payload.get('bridge_version'), payload.get('bridge_protocol')
            if type(busy) is not bool or version is not None and (not isinstance(version, str) or len(version) > 40):
                raise ValueError('无效的主界面状态')
            if protocol is not None and (type(protocol) is not int or not 1 <= protocol <= 2**31 - 1):
                raise ValueError('无效的主界面协议版本')
            return await self.poll(payload.get('client_id'), payload.get('character'), busy, version, rid, protocol)
        if command == 'start':
            if not isinstance(payload.get('epoch'), str) or payload.get('stop_epoch') != self.stop_epoch:
                raise ValueError('请刷新广告部界面后重新确认开局')
            owner, voice = payload.get('owner'), payload.get('voice_enabled', True)
            if not valid_id(owner) or type(voice) is not bool:
                raise ValueError('无效的开局设置')
            return await self.start(rid, owner, payload.get('confirmed'), payload.get('shortcut', DEFAULT_SHORTCUT), voice, payload['epoch'], payload['stop_epoch'])
        if command == 'stop':
            if rid is None and not valid_id(payload.get('stop_epoch')):
                raise ValueError('停止请求需要游戏标识或有效的停止代次')
            return await self.stop(rid, epoch=payload.get('stop_epoch') if rid is None else None)
        if command == 'shortcut':
            return await self.change_shortcut(payload.get('round_id'), payload.get('shortcut', ''))
        if command == 'speech':
            # The watcher maintains the current voice token. The playback path
            # must only read prepared data, never wait for provider/config I/O.
            return self.speech(payload.get('round_id'), payload.get('event'), payload.get('sequence'))
        if command == 'voice':
            enabled = payload.get('enabled')
            if type(enabled) is not bool:
                raise ValueError('无效的语音设置')
            self.voice_enabled = enabled
            self.cancel_speech()
            if self.bank:
                self.bank.enable(enabled)
            self.next_voice_check = 0
            return self.snapshot()
        if command == 'prepare_voice':
            if self.bank and self.voice_enabled:
                self.bank.retry()
                self.next_voice_check = 0
            return self.snapshot()
        if command == 'voice_clip':
            import base64
            token, offset = payload.get('token'), payload.get('offset', 0)
            if not valid_id(token):
                raise ValueError('无效的音频标识')
            if type(offset) is not int or not 0 <= offset <= 4_000_000:
                raise ValueError('无效的音频位置')
            if self.bank and self.bank.character:
                clip = self.bank.clip(event)
                if clip and token == self.bank.token:
                    if offset > len(clip[0]):
                        raise ValueError('无效的音频位置')
                    resource = self.bank.resource(event)
                    if resource:
                        return {'audio_url':'/ui/voice-cache/' + resource,'mime':clip[1],'voice_token':self.bank.token}
                    end = min(offset + 48_000, len(clip[0]))
                    return {'audio':base64.b64encode(clip[0][offset:end]).decode('ascii'), 'mime':clip[1], 'voice_token':self.bank.token,
                            'next_offset':end, 'total':len(clip[0]), 'ready':end == len(clip[0])}
            return {}
        if command == 'speech_result':
            job_id = payload.get('job_id')
            if not isinstance(job_id, str) or not 1 <= len(job_id) <= 120:
                raise ValueError('无效的语音任务标识')
            return self.speech_result(job_id)
        if command == 'cancel_speech':
            preserve = payload.get('preserve', False)
            if type(preserve) is not bool:
                raise ValueError('无效的语音取消设置')
            if rid == self.round_id:
                if sequence is None or sequence >= self.speech_sequence:
                    if sequence is not None:
                        self.speech_sequence = sequence
                    self.cancel_speech(preserve=preserve)
            return {}
        raise ValueError('不支持的广告操作')
