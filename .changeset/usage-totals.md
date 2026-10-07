---
"@neta-art/cohub": minor
"@neta-art/cohub-cli": minor
---

Usage responses carry `totals`, one figure for LLM and generation together: `totalTokens`, `requestCount`, `successCount`, `errorCount`, and `costTotal`. `space.usage.get()`, `space.activity.get()`, and `user.getActivity()` all return it; `summary` stays LLM only. Space activity zeroes `totals.costTotal` for viewers who cannot see cost. `cohub me activity`, `cohub spaces usage`, and `cohub spaces activity` now report these totals, so requests and cost include generation calls, and a Space whose only spend is generation still shows its cost.

用量响应新增 `totals`，把 LLM 与生成调用合并为一组数据：`totalTokens`、`requestCount`、`successCount`、`errorCount` 和 `costTotal`。`space.usage.get()`、`space.activity.get()` 和 `user.getActivity()` 都会返回它；`summary` 仍只统计 LLM。对无权查看费用的成员，Space activity 中的 `totals.costTotal` 为 0。`cohub me activity`、`cohub spaces usage` 和 `cohub spaces activity` 改为输出这组合计，请求数与费用都包含生成调用，只有生成费用的 Space 也能正常显示费用。
