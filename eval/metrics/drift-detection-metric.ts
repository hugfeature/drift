/**
 * DeepEval-compatible metric interface for Drift detection.
 *
 * DeepEval expects metrics to produce:
 *   - score: 0-1 float (higher = better detection)
 *   - reason: explanation string
 *   - is_successful: boolean threshold check
 *
 * This module wraps Drift's eval runner output into DeepEval's expected format,
 * enabling integration via JSON bridge (TS → JSON → Python DeepEval).
 *
 * Usage:
 *   npx ts-node eval/metrics/drift-detection-metric.ts [--threshold 0.5]
 *
 * Output: eval/reports/deepeval-compatible.json
 */

import * as fs   from 'fs'
import * as path from 'path'

// ---------------------------------------------------------------------------
// DeepEval metric types (mirrors deepeval.metrics.BaseMetric output)
// ---------------------------------------------------------------------------

export interface DeepEvalTestCase {
  input:           string
  actual_output:   string
  expected_output: string
  context?:        string[]
  retrieval_context?: string[]
}

export interface DeepEvalMetricResult {
  name:          string
  score:         number
  threshold:     number
  is_successful: boolean
  reason:        string
  evaluation_model?: string
  evaluation_cost?:  number
}

export interface DeepEvalTestResult {
  test_case:    DeepEvalTestCase
  metrics:      DeepEvalMetricResult[]
  success:      boolean
  run_duration: number
}

export interface DeepEvalDataset {
  test_cases:  DeepEvalTestResult[]
  overall:     DeepEvalOverall
  metadata:    DeepEvalMetadata
}

export interface DeepEvalOverall {
  total_tests:       number
  successful_tests:  number
  failed_tests:      number
  overall_score:     number
  metrics_summary:   Record<string, { mean: number; min: number; max: number }>
}

export interface DeepEvalMetadata {
  evaluation_model:  string
  framework:         string
  framework_version: string
  timestamp:         string
}

// ---------------------------------------------------------------------------
// Convert Drift eval report → DeepEval format
// ---------------------------------------------------------------------------

interface DriftEvalReport {
  timestamp:   string
  total:       number
  metrics:     { precision: number; recall: number; f1: number; passed: number; failed: number }
  per_type:    Array<{ type: string; total: number; detected: number; missed: number; recall: number }>
  results:     Array<{
    fixture_id:     string
    description:    string
    drift_type:     string | undefined
    expected_drift: boolean
    detected_drift: boolean
    final_score:    number
    drift_status:   string
    passed:         boolean
  }>
}

export function convertToDeepEval(
  report: DriftEvalReport,
  threshold = 0.5
): DeepEvalDataset {
  const testResults: DeepEvalTestResult[] = report.results.map(result => {
    const testCase: DeepEvalTestCase = {
      input:           `Session: ${result.fixture_id} — ${result.description}`,
      actual_output:   `drift_detected=${result.detected_drift}, score=${result.final_score}, status=${result.drift_status}`,
      expected_output: `drift=${result.expected_drift}, type=${result.drift_type ?? 'none'}`,
    }

    const detectionAccuracy: DeepEvalMetricResult = {
      name:          'DriftDetectionAccuracy',
      score:         result.passed ? 1.0 : 0.0,
      threshold:     threshold,
      is_successful: result.passed,
      reason:        result.passed
        ? `Correctly ${result.detected_drift ? 'detected' : 'did not detect'} drift (score=${result.final_score.toFixed(3)})`
        : `Expected drift=${result.expected_drift}, got detected=${result.detected_drift} (score=${result.final_score.toFixed(3)})`,
      evaluation_model: 'DriftScorer/keyword-embedding',
    }

    const scorePrecision: DeepEvalMetricResult = {
      name:          'DriftScorePrecision',
      score:         result.final_score,
      threshold:     threshold,
      is_successful: result.expected_drift === (result.final_score >= threshold),
      reason:        `Raw drift score: ${result.final_score.toFixed(3)} (${result.drift_status})`,
      evaluation_model: 'DriftScorer/keyword-embedding',
    }

    return {
      test_case:    testCase,
      metrics:      [detectionAccuracy, scorePrecision],
      success:      result.passed,
      run_duration: 0,
    }
  })

  const scores = testResults.map(t => t.metrics[0].score)
  const precisionScores = testResults.map(t => t.metrics[1].score)

  const overall: DeepEvalOverall = {
    total_tests:      report.total,
    successful_tests: report.metrics.passed,
    failed_tests:     report.metrics.failed,
    overall_score:    report.metrics.f1,
    metrics_summary: {
      DriftDetectionAccuracy: {
        mean: scores.reduce((a, b) => a + b, 0) / scores.length,
        min:  Math.min(...scores),
        max:  Math.max(...scores),
      },
      DriftScorePrecision: {
        mean: precisionScores.reduce((a, b) => a + b, 0) / precisionScores.length,
        min:  Math.min(...precisionScores),
        max:  Math.max(...precisionScores),
      },
    },
  }

  const metadata: DeepEvalMetadata = {
    evaluation_model:  'DriftScorer/keyword-embedding',
    framework:         'drift',
    framework_version: '0.1.0',
    timestamp:         report.timestamp,
  }

  return { test_cases: testResults, overall, metadata }
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const reportsDir = path.join(__dirname, '..', 'reports')
  const files = fs.readdirSync(reportsDir)
    .filter(f => f.startsWith('eval-') && f.endsWith('.json'))
    .sort()

  if (files.length === 0) {
    console.error('No eval reports found. Run eval/runner.ts first.')
    process.exit(1)
  }

  const latestFile = files[files.length - 1]
  const reportPath = path.join(reportsDir, latestFile)
  const report: DriftEvalReport = JSON.parse(fs.readFileSync(reportPath, 'utf-8'))

  const thresholdArg = process.argv.find(a => a.startsWith('--threshold='))
  const threshold = thresholdArg ? parseFloat(thresholdArg.split('=')[1]) : 0.5

  const deepEvalDataset = convertToDeepEval(report, threshold)

  const outputPath = path.join(reportsDir, 'deepeval-compatible.json')
  fs.writeFileSync(outputPath, JSON.stringify(deepEvalDataset, null, 2))

  console.log(`✓ DeepEval-compatible report generated: ${outputPath}`)
  console.log(`  Source:     ${latestFile}`)
  console.log(`  Tests:      ${deepEvalDataset.overall.total_tests}`)
  console.log(`  Passed:     ${deepEvalDataset.overall.successful_tests}`)
  console.log(`  F1:         ${deepEvalDataset.overall.overall_score}`)
  console.log(`  Threshold:  ${threshold}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
