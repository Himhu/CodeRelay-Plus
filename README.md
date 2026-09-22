# CodeRelay Plus

上游渠道监控站。接入 Sub2API 调度站和上游供应商，探测模型、比对倍率，并把达标线路推到调度站。

## 本地

```sh
npm install
npm run dev
```

## 发布

见 `deploy/README.md`。用 `deploy/build-release.mjs` 生成发布包，再在服务器上执行 `activate-release.sh`。不要使用 PM2 或 `vite preview`。

功能说明见 `docs/功能介绍.zh-CN.md`。
