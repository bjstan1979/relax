# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**静心 · 声音疗愈** — 一个通过播放特定声音帮助用户获得内心平静的纯网页应用。

## Architecture

- **纯前端单页应用**：`index.html` 包含所有 HTML/CSS/JS，无需构建工具
- **声音引擎**：使用 Web Audio API 程序化生成所有声音，无需外部音频文件
  - 脑波双耳节拍（θ/α/δ/β/γ）：双声道正弦波频率差
  - 颂钵：多频率正弦波叠加 + 周期性触发衰减
  - 自然声音（雨/海浪/白噪音/鸟鸣/溪流/风声）：噪音缓冲区 + 滤波器组合
- **视觉**：Canvas 粒子背景 + CSS 动画呼吸引导

## Key Entry Points

- `index.html` — 唯一入口文件，包含全部代码
- `GENERATORS` 对象 — 声音生成器映射
- `SOUNDS` / `PRESETS` 数组 — 声音和预设配置

## Development

直接在浏览器中打开 `index.html` 即可运行，无需服务器。

## Conventions

- 所有声音通过 Web Audio API 程序化生成，不依赖外部音频文件
- 声音开关使用淡入/淡出过渡，避免爆音
- 定时器最后 30 秒自动渐弱停止
