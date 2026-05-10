# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Mission

**静心 · 声音疗愈** — 一款纯网页声音疗愈应用，通过播放特定声音（脑波、颂钵、自然声）帮助用户获得内心平静。核心价值：打开即用，无需安装，熄屏不停。

## Architecture & Files

```
relax/
├── index.html              # 唯一入口，包含全部 HTML/CSS/JS（~2515行）
│   ├── CSS                 # 全部样式（暗色主题、卡片布局、动画）
│   ├── Audio Engine        # Web Audio API 音频引擎（核心）
│   ├── HRV Biofeedback     # Web Bluetooth → Polar H10 → HRV计算 → 声音调制
│   ├── Smart Recommend     # HRV驱动智能声音推荐引擎
│   ├── UI Rendering        # 声音卡片、预设、定时器渲染
│   └── State Management    # 播放状态、定时器、暂停、智能推荐逻辑
├── audio_processed/        # 12个MP3音频文件（共~9.7MB）
│   ├── theta/alpha/delta/beta/gamma.mp3  # 脑波双耳节拍
│   ├── bowl.mp3                          # 颂钵
│   └── rain/ocean/whitenoise/birds/stream/wind.mp3  # 自然声音
├── favicon.svg             # 网站图标
└── CLAUDE.md               # 本文件
```

### 音频引擎架构（MediaStreamDestination 桥接方案）

```
AudioBufferSourceNode (每个声音独立)
        ↓
    GainNode (独立音量控制)
        ↓
masterStreamDest (MediaStreamDestination，全局唯一)
        ↓ stream
masterAudioElement (<audio> 元素，持有 iOS 媒体会话)
        ↓
    系统音频输出
```

关键变量：
- `masterAudioCtx` — AudioContext 单例
- `masterStreamDest` — MediaStreamDestination，所有音频汇入此处
- `masterAudioElement` — 播放 stream 的 `<audio>` 元素，iOS 后台播放的命脉
- `audioBuffers` — 已解码的 AudioBuffer 缓存
- `activeSounds` — 当前活跃声音状态（gainNode/source/volume）
- `SOUNDS` / `PRESETS` — 声音和预设配置数组
- `HRV_PROFILES` — 7种HRV驱动智能声音配置
- `hrvState` — 实时HRV状态（heartRate/rmssd/sdnn/hrvLevel/rrBuffer）
- `smartModeActive` — 智能推荐开关

## Current State

**版本**：v1.1（已发布至 GitHub: https://github.com/bjstan1979/relax）

**已解决的核心痛点**：
- iOS 熄屏无声 → 通过 MediaStreamDestination 桥接方案解决
- iOS 音量不可调 → GainNode 在 `<audio>` 元素之前控制音量
- 定时器熄屏不准 → 使用绝对时间 `timerEndTime = Date.now() + ...` 替代递减计数
- 音量滑块误触 → volume-control div 添加 ontouchstart/onmousedown stopPropagation

**已实现功能**：
- 12种声音播放（脑波5种 + 颂钵 + 自然声6种），各自独立音量控制
- 5个预设场景（深度冥想/睡眠辅助/专注工作/自然放松/疗愈时刻）
- **7种HRV驱动智能声音配置**（深度放松/温和放松/过渡放松/平静专注/保持放松/温和唤醒/深度冥想）
- 定时器（5/10/15/20/30/60分钟），最后30秒自动渐弱
- 全局暂停/恢复、重置
- Canvas 粒子背景 + CSS 呼吸引导动画（4-7-8 / 共振呼吸）
- Media Session API 锁屏控制
- Wake Lock API 防息屏
- 自定义配置保存/加载（localStorage）
- **HRV生物反馈**：Polar H10 BLE连接 → 实时HR/RR/RMSSD/SDNN → 声音调制+视觉反馈
- **智能声音推荐**：根据心率+HRV自动选择最佳声音组合，平滑切换，手动覆盖暂停5分钟
- **共振呼吸**：5s吸气+5s呼气（~6次/分），呼吸圆颜色随HRV同步
- **视觉反馈**：粒子颜色/速度、呼吸圆颜色、心率波形颜色随HRV状态变化
- **RR异常值过滤**：生理范围(300-2000ms) + 中位数偏差>20%
- **iOS降级**：检测Web Bluetooth支持，不支持时显示兼容提示

## Pending Tasks

- [ ] PWA 支持（manifest.json + Service Worker），实现"添加到主屏幕"
- [ ] 离线缓存（Cache API），断网也能使用
- [ ] 更多声音素材（用户反馈驱动）
- [ ] 深色/浅色主题切换
- [ ] 国际化（i18n）

## Strict Rules

1. **绝对禁止连接到 `ctx.destination`**：所有音频节点必须连接到 `masterStreamDest`，绝不能直接连 `ctx.destination`。违反此规则将导致 iOS 熄屏无声。
2. **禁止使用 `createMediaElementSource`**：iOS 会在锁屏时静音通过此 API 路由的音频。
3. **禁止引入构建工具**：项目必须是纯 HTML/CSS/JS 单文件，直接浏览器打开即可运行。
4. **禁止依赖外部音频服务**：所有音频文件必须本地存储在 `audio_processed/` 目录。
5. **声音开关必须淡入淡出**：任何声音的启停都必须经过音量渐变，禁止硬切（避免爆音）。
6. **iOS 兼容性优先**：所有音频相关改动必须优先验证 iOS Safari 行为，包括熄屏、锁屏控制、首次交互解锁。
7. **首次交互必须解锁音频**：`unlockAudio` 函数中必须同时调用 `ctx.resume()` 和 `masterAudioElement.play()`，缺一不可。
8. **必须通过HTTP服务器访问**：Web Bluetooth API 在 `file://` 协议下不可用，必须通过 HTTP 服务器部署。
