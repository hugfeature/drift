# Eval Fixture Review 操作指南

## 概述

Drift 的 eval fixtures 会随使用自动增长。`claude-hook` 在每次 session 结束时，自动收集高置信度的 session 作为候选 fixture，存放在 `eval/candidates/`。

你需要定期 review 这些候选，确认标签正确后批准进入正式 eval set。

**频率建议**：每周一次，或 candidates 积累到 5+ 个时。

---

## 日常 Review 流程

### Step 1：查看候选列表

```bash
cd /path/to/drift
npx ts-node scripts/review-candidates.ts
```

输出示例：
```
📋 3 candidate fixture(s) pending review:

  ID                          | Label   | Conf   | Score | Events | Goal
  ----------------------------|---------|--------|-------|--------|------
  auto_abc123_x9f2            | DRIFT   | high   |  0.85 |     12 | fix login bug...
  auto_def456_k3m1            | ALIGNED | high   |  0.08 |     15 | add unit tests...
  auto_ghi789_p2q4            | DRIFT   | medium |  0.72 |      9 | refactor auth...
```

### Step 2：判断标签是否正确

**判断标准**：
- **high confidence** → goal 和 label 明显匹配的，直接批准
- **medium confidence** → 打开 JSON 看一眼事件流确认

```bash
# 查看某个 candidate 的事件流
cat eval/candidates/candidate_auto_abc123_x9f2.json | jq '.session.events[] | {tool: .payload.tool_name, target: .payload.target}' | head -30
```

### Step 3：批准或拒绝

```bash
# 批准单个
npx ts-node scripts/review-candidates.ts --approve auto_abc123_x9f2

# 拒绝单个
npx ts-node scripts/review-candidates.ts --reject auto_ghi789_p2q4

# 一键批准所有高置信度的（省事）
npx ts-node scripts/review-candidates.ts --approve-all
```

### Step 4：（可选）跑 eval 确认指标没掉

```bash
npx ts-node eval/runner.ts --fixture-dir=eval/fixtures-valid
```

### Step 5：提交

```bash
git add eval/fixtures-valid/ eval/candidates/
git commit -m "eval: approve N new auto-collected fixtures"
```

---

## 快速版（30 秒搞定）

```bash
cd /Users/wangzhaoxian/skill/drift
npx ts-node scripts/review-candidates.ts
npx ts-node scripts/review-candidates.ts --approve-all
git add eval/ && git commit -m "eval: approve auto-collected fixtures"
```

---

## 问题处理

### 标签错了（scorer 判断有误）

```bash
# 方式 A：直接拒绝
npx ts-node scripts/review-candidates.ts --reject auto_xxx

# 方式 B：翻转标签后批准（有 eval 价值的 case）
vim eval/candidates/candidate_auto_xxx.json
# 把 "drift": true 改成 false（或反过来）
npx ts-node scripts/review-candidates.ts --approve auto_xxx
```

### 边界 case（drift/aligned 都说得通）

```bash
# 先 approve
npx ts-node scripts/review-candidates.ts --approve auto_xxx

# 然后给 fixture 加 worth_inspection 标记
# 找到刚生成的 case_NNN.json
jq '.label.worth_inspection = true' eval/fixtures-valid/case_NNN.json > tmp && mv tmp eval/fixtures-valid/case_NNN.json
```

> `worth_inspection: true` 的 fixture 不参与 Precision/Recall 计算，但参与 explainability 评估。

### 数据质量差（事件太少、goal 是图片/乱码等）

```bash
npx ts-node scripts/review-candidates.ts --reject auto_xxx
```

### approve 后 eval 指标掉了

```bash
# 1. 跑 eval 定位问题 case
npx ts-node eval/runner.ts --fixture-dir=eval/fixtures-valid

# 2. 把问题 fixture 移到隔离区
mv eval/fixtures-valid/case_NNN.json eval/quarantine/

# 3. 提交
git add eval/ && git commit -m "eval: quarantine case_NNN (label disputed)"
```

---

## 收集规则

自动收集的阈值（可在 `src/eval/candidate-collector.ts` 调整）：

| 条件 | 动作 |
|------|------|
| final_score ≥ 0.70 | 收集为 drift candidate |
| final_score ≤ 0.15 | 收集为 aligned candidate |
| 0.15 < score < 0.70 | 跳过（信号不够强） |
| event_count < 8 | 跳过（session 太短） |
| goal 为空或 < 3 字符 | 跳过 |

候选上限 50 个，超出后自动 FIFO 淘汰最老的。

---

## 快速参考

| 我想... | 命令 |
|---------|------|
| 看有多少候选 | `npx ts-node scripts/review-candidates.ts` |
| 批准一个 | `npx ts-node scripts/review-candidates.ts --approve <id>` |
| 拒绝一个 | `npx ts-node scripts/review-candidates.ts --reject <id>` |
| 批量过高置信度 | `npx ts-node scripts/review-candidates.ts --approve-all` |
| 跑 eval | `npx ts-node eval/runner.ts --fixture-dir=eval/fixtures-valid` |
| 隔离问题 fixture | `mv eval/fixtures-valid/case_NNN.json eval/quarantine/` |
