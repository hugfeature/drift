# 我为什么在 DeepEval 之外还要自己做 DriftScorer

## TL;DR

DeepEval 评测的是 LLM 输出质量。DriftScorer 评测的是 Agent 运行时行为偏移。

一个回答"这个回答有没有幻觉"，另一个回答"这个 Agent 还在做你让它做的事吗"。

它们不矛盾，但解决的是完全不同层面的问题。

---

## 起因：一次 45 分钟的 README typo 修复

我让 Agent 修一个 README 错别字。

它修了。然后它注意到一个 lint 警告。然后它把 eslint 升级到 v9。然后 build 挂了。然后它修 build。然后测试挂了。然后它修测试。

45 分钟后：三个文件改了，原始任务早已被遗忘。Agent 全程努力工作，没有 crash，没有死循环，没有报错。

**DeepEval 的每一个 metric 都会说这个 Agent 表现正常。**

因为 DeepEval 评测的是：回答相关吗？有幻觉吗？上下文用对了吗？格式对吗？

它不评测：Agent 还在做你让它做的事吗？

这就是 Goal Drift —— 不是 crash，不是幻觉，是 Agent 在做错误的事做得很好。

---

## DeepEval 做了什么，做得很好

先说清楚：DeepEval 是一个优秀的 LLM 评测框架。它的核心 metrics：

- **Faithfulness**：回答是否基于提供的上下文
- **Answer Relevancy**：回答是否切题
- **Contextual Precision/Recall**：检索到的上下文是否正确
- **Hallucination**：输出是否包含虚构内容
- **Toxicity/Bias**：安全检查

这些都是 **单轮/少轮对话质量** 的评测。它解决的问题是："给定这个输入，这个输出好不好？"

---

## DeepEval 覆盖不了的三个运行时故障

当 Agent 变成长时间自主运行（30分钟+，50+ tool calls），新的故障模式出现了：

### 1. Goal Drift（目标偏移）

Agent 逐渐偏离原始目标，但每一步看起来都合理。

DeepEval 无法检测这个，因为：
- 它没有"原始目标"的概念
- 它不跟踪时间维度上的行为变化
- 单独看每一步 tool call 都是"合理"的

### 2. Hallucinated Runtime State（运行时幻觉）

Agent 声称"测试通过了"，但实际 stdout 里写着 `FAIL`。

这不是 DeepEval 定义的 Hallucination（输出和上下文不一致）。这是 **Agent 对自己执行结果的错误解读**。需要对比 `tool_response` 的真实内容和 Agent 的行为。

### 3. Safety Violations（危险操作）

Agent 执行 `sudo rm -rf /` 或者读取 `.env` 文件。

这不是"回答质量"问题。这是运行时安全问题，需要对 tool_call 的实际参数做规则匹配。

---

## DriftScorer：我做了什么

8 周时间，从零到当前状态：

```
62 labeled fixtures | 31 tests | Precision 0.545 | Recall 0.909 | F1 0.682
```

### 架构

```
EventIngestion → GoalStore → DriftScorer (8 signals)
                                ↑
                          ClaimChecker (hallucination)
                          SafetyScanner (25 rules)
                                ↓
                     NarrativeEngine → TakeoverEngine (6 triggers)
                                ↓
                       LangSmithExporter (trace)
```

### 8 个评分信号

| 信号 | 权重 | 含义 |
|------|------|------|
| semantic_divergence | 0.22 | 当前操作和目标的语义距离 |
| autonomy_momentum | 0.22 | 会话时长 × 工具/人类交互比 |
| inactive_duration | 0.13 | 目标多久没收到对齐行为 |
| consecutive_unrelated | 0.13 | 连续无关操作数 |
| hallucinated_claims | 0.10 | 未验证的执行声明计数 |
| exploratory_entropy | 0.10 | 工具使用的香农熵 |
| subgoal_depth | 0.05 | 子目标嵌套深度 |
| unauthorized_mutations | 0.05 | 未授权目标变更 |

### 关键决策：不用 embedding 模型

第一版尝试过 OpenAI text-embedding-3-small。结果：

- 增加了 200ms+ 延迟
- 对 drift 检测的边际提升 < 5%
- 引入了网络依赖（Agent runtime 不能依赖外部 API）

最终方案：keyword stemming + synonym groups + domain-hit similarity。纯本地，0ms 延迟，效果够用。

这是 DriftScorer 和 DeepEval 的另一个区别：**DeepEval 可以慢，因为它是离线评测。DriftScorer 必须快，因为它在运行时检测。**

---

## 踩的坑

### 坑 1：Precision 低于预期

当前 Precision 0.545，意味着报出来的 drift 有一半是误报。

根因分析：导入的真实 session 中，很多 Agent 合理地在多个文件间跳转（比如 debug 时读 log、读 config），被 `consecutive_unrelated` 和 `semantic_divergence` 误判为 drift。

**还没解决。** 下一步需要更好的"合理探索"和"漫无目的"的区分。

### 坑 2：Hallucination Detection 的假阳性

ClaimChecker 通过文件 mtime 验证"文件是否真的被写了"。但有些 Agent 工具报告 edit 成功后，文件系统的 mtime 更新有 race condition（特别是 WSL/Docker 环境）。

当前做法：允许 5 秒 slack。不完美，但可用。

### 坑 3：`conflicting_context` 类型的 fixture 很难让 scorer 检测到

Agent 在矛盾文档间来回切换（v2 文档说用 v2，ticket 说迁移到 v3），但它始终在同一个语义域内操作。

semantic_divergence 计算出来的分数低，因为"payment client"和"payment API v3 migration"太近了。scorer 看不出来 Agent 实际上在做无用功。

**当前解决方案：** 让 fixture 更极端（Agent 从 payment 跑去改 CSS）。但这掩盖了真实问题。未来需要新信号：**edit-revert 检测**（同一文件被来回改 3+ 次）。

### 坑 4：LangSmith 集成的 race condition

`processEvent()` 是同步调用，但 LangSmith client 是异步的。早期 fire-and-forget 导致 `finalize()` 时 parent run 还没注册。

修复：await every trace call。牺牲了一点延迟，但保证了正确性。

---

## 和 DeepEval 的关系

不是替代，是互补。

| 维度 | DeepEval | DriftScorer |
|------|----------|-------------|
| 评测对象 | LLM 单轮输出 | Agent 运行时行为流 |
| 时间维度 | 无 | 核心（drift 是时间现象） |
| 运行位置 | 离线 | 运行时 + 离线 |
| 典型问题 | "回答有幻觉吗？" | "Agent 还在做你要求的事吗？" |
| 信号来源 | input/output pair | event stream（50+ tool calls） |
| 延迟要求 | 秒级可接受 | 必须 < 50ms |

我甚至给 DriftScorer 做了 DeepEval-compatible 的 JSON 输出格式，方便未来两者结合使用。

---

## 当前状态（诚实版）

**做到了什么：**
- 从真实 Agent session 检测 goal drift，Recall 0.909
- Hallucinated State 检测：验证 tool_response 真实性
- 安全评测：25 条规则检测危险操作
- LangSmith 自动集成：每次评分自动上报
- 62 个真实 fixture 的 benchmark
- 31 个单测全部通过

**没做到什么：**
- Precision 只有 0.545（误报率高）
- keyword embedding 不如真实 embedding 精确
- `conflicting_context` 和 `interrupted_workflow` 类型检测能力弱
- 只支持 Claude Code adapter，Cursor/OpenAI 还没做
- 没有 multi-agent 支持

**核心洞察：**

> Autonomous Agent 的核心挑战正在从模型智能向运行时可靠性转移。

当 Agent 变成长时间自主运行，"输出质量"不再是唯一的评测维度。"行为对齐"、"状态真实性"、"操作安全性"变成了同等重要的问题。

DeepEval 回答前者。DriftScorer 回答后者。

---

## 代码

开源地址：[github.com/hugfeature/drift](https://github.com/hugfeature/drift)

```bash
npm install
npm run demo      # 看一个 drift 检测的完整流程
npm test          # 31 个单测
npm run eval      # 62 fixtures benchmark
```

---

*2026.05*
