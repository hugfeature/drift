/**
 * Batch scan all session directories, rank by drift probability.
 *
 * Usage:
 *   npx ts-node scripts/batch-scan.ts [--top N] [--export file.json]
 *   npx ts-node scripts/batch-scan.ts --auto-import N
 */

import * as fs from 'fs'
import * as path from 'path'
import { execSync } from 'child_process'

interface SessionCandidate {
  file: string
  source: string
  toolCalls: number
  interrupts: number
  userPrompts: string[]
  durationMinutes: number
  driftScore: number
  alreadyImported: boolean
}

const HOME = process.env.HOME || '/Users/wangzhaoxian'

const CLAUDE_DIRS = [
  path.join(HOME, '.codefuse/engine/cc/projects'),
  path.join(HOME, '.codefuse/fuse/engine/cc/projects'),
]

const OPENCLAW_DIRS = [
  path.join(HOME, '.openclaw/agents/main/sessions'),
  path.join(HOME, '.openclaw/agents/claude-code/sessions'),
  path.join(HOME, '.openclaw/agents/work/sessions'),
  path.join(HOME, '.homiclaw/agents/main/sessions'),
]

function findFiles(dirs: string[], pattern: string, excludes: string[]): string[] {
  const results: string[] = []
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue
    const excludeFlags = excludes.map(e => `! -path "*${e}*"`).join(' ')
    try {
      const cmd = `find "${dir}" -name "${pattern}" -size +10k ${excludeFlags} 2>/dev/null`
      const output = execSync(cmd, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }).trim()
      if (output) results.push(...output.split('\n'))
    } catch { /* skip */ }
  }
  return results
}

function analyzeClaudeFile(filePath: string): SessionCandidate | null {
  try {
    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n')
    let toolCalls = 0
    let interrupts = 0
    const userPrompts: string[] = []
    let firstTs = ''
    let lastTs = ''

    for (const line of lines) {
      let d: any
      try { d = JSON.parse(line) } catch { continue }
      if (d.timestamp) { if (!firstTs) firstTs = d.timestamp; lastTs = d.timestamp }

      if (d.type === 'user' && Array.isArray(d.message?.content)) {
        for (const b of d.message.content) {
          if (b?.type === 'text' && b.text) {
            const t = (b.text as string).trim()
            if (t.toLowerCase().includes('interrupted')) { interrupts++ }
            else if (t.length > 5 && !t.startsWith('Base directory') && !t.startsWith('[Image:') && !t.startsWith('Invoke the')) {
              userPrompts.push(t.slice(0, 80))
            }
          }
        }
      }
      if (d.type === 'assistant' && Array.isArray(d.message?.content)) {
        for (const b of d.message.content) {
          if (b?.type === 'tool_use') toolCalls++
        }
      }
    }

    if (toolCalls < 5) return null
    const startMs = firstTs ? new Date(firstTs).getTime() : 0
    const endMs = lastTs ? new Date(lastTs).getTime() : 0
    const dur = (startMs && endMs) ? Math.round((endMs - startMs) / 60000) : 0

    return {
      file: filePath, source: 'claude', toolCalls, interrupts,
      userPrompts: userPrompts.slice(0, 5), durationMinutes: dur,
      driftScore: heuristic(toolCalls, interrupts, userPrompts.length, dur),
      alreadyImported: false,
    }
  } catch { return null }
}

function analyzea third-party CLIFile(filePath: string): SessionCandidate | null {
  try {
    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n')
    let toolCalls = 0
    const userPrompts: string[] = []
    let firstTs = ''
    let lastTs = ''

    for (const line of lines) {
      let d: any
      try { d = JSON.parse(line) } catch { continue }
      const ts = d.ts || ''
      if (ts) { if (!firstTs) firstTs = ts; lastTs = ts }

      if (d.type === 'prompt.submitted') {
        const p = d.data?.prompt as string || ''
        if (p && !p.startsWith('[a third-party CLI heartbeat') && !p.startsWith('Sender (untrusted')) {
          userPrompts.push(p.slice(0, 80))
        }
      }
      if (d.type === 'trace.artifacts') {
        const metas = d.data?.toolMetas as any[] || []
        toolCalls += metas.length
      }
    }

    if (toolCalls < 5) return null
    const startMs = firstTs ? new Date(firstTs).getTime() : 0
    const endMs = lastTs ? new Date(lastTs).getTime() : 0
    const dur = (startMs && endMs) ? Math.round((endMs - startMs) / 60000) : 0

    return {
      file: filePath, source: 'openclaw', toolCalls, interrupts: 0,
      userPrompts: userPrompts.slice(0, 5), durationMinutes: dur,
      driftScore: heuristic(toolCalls, 0, userPrompts.length, dur),
      alreadyImported: false,
    }
  } catch { return null }
}

function heuristic(tools: number, interrupts: number, prompts: number, durMin: number): number {
  let score = 0
  if (tools > 200) score += 0.3
  else if (tools > 100) score += 0.2
  else if (tools > 50) score += 0.1

  if (interrupts >= 4) score += 0.4
  else if (interrupts >= 2) score += 0.3
  else if (interrupts >= 1) score += 0.15

  const ratio = prompts > 0 ? tools / prompts : tools
  if (ratio > 100) score += 0.2
  else if (ratio > 50) score += 0.1

  if (durMin > 500) score += 0.1
  else if (durMin > 200) score += 0.05

  return Math.min(score, 1.0)
}

function getImportedSessions(): Set<string> {
  const dir = path.join(process.cwd(), 'eval', 'fixtures')
  const ids = new Set<string>()
  if (!fs.existsSync(dir)) return ids
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.json'))) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'))
      const sid = (data.session?.id || '').replace('sess_', '')
      if (sid) ids.add(sid)
    } catch { /* skip */ }
  }
  return ids
}

function main() {
  const args = process.argv.slice(2)
  const topIdx = args.indexOf('--top')
  const topN = topIdx >= 0 ? parseInt(args[topIdx + 1] || '50', 10) : 50
  const expIdx = args.indexOf('--export')
  const exportFile = expIdx >= 0 ? args[expIdx + 1] : null
  const autoIdx = args.indexOf('--auto-import')
  const autoImport = autoIdx >= 0 ? parseInt(args[autoIdx + 1] || '10', 10) : 0

  console.log('Scanning session directories...\n')

  const claudeFiles = findFiles(CLAUDE_DIRS, '*.jsonl', ['subagents', 'backup', 'plugins', 'history.jsonl'])
  const openclawFiles = findFiles(OPENCLAW_DIRS, '*.trajectory.jsonl', [])
  console.log('  Claude transcripts: ' + claudeFiles.length)
  console.log('  a third-party CLI trajectories: ' + openclawFiles.length)
  console.log()

  const candidates: SessionCandidate[] = []
  let count = 0
  const total = claudeFiles.length + openclawFiles.length

  for (const f of claudeFiles) {
    count++
    if (count % 50 === 0) process.stderr.write('  Progress: ' + count + '/' + total + '\r')
    const r = analyzeClaudeFile(f)
    if (r) candidates.push(r)
  }
  for (const f of openclawFiles) {
    count++
    if (count % 50 === 0) process.stderr.write('  Progress: ' + count + '/' + total + '\r')
    const r = analyzea third-party CLIFile(f)
    if (r) candidates.push(r)
  }
  console.log('  Valid sessions: ' + candidates.length + '\n')

  const imported = getImportedSessions()
  for (const c of candidates) {
    const bn = path.basename(c.file).replace(/\.(trajectory\.)?jsonl$/, '')
    if (imported.has(bn)) c.alreadyImported = true
  }

  candidates.sort((a, b) => b.driftScore - a.driftScore)
  const notImported = candidates.filter(c => !c.alreadyImported)
  const display = notImported.slice(0, topN)

  console.log('=== TOP ' + display.length + ' DRIFT CANDIDATES (not yet imported) ===\n')
  console.log(pad('#', 4) + pad('Score', 7) + pad('Tools', 7) + pad('Int', 5) + pad('Dur', 8) + pad('Src', 9) + 'File')
  console.log('-'.repeat(95))

  for (let i = 0; i < display.length; i++) {
    const c = display[i]
    const bn = path.basename(c.file).slice(0, 40)
    console.log(
      pad(String(i + 1), 4) +
      pad(c.driftScore.toFixed(2), 7) +
      pad(String(c.toolCalls), 7) +
      pad(String(c.interrupts), 5) +
      pad(c.durationMinutes + 'm', 8) +
      pad(c.source, 9) +
      bn
    )
    if (c.userPrompts.length > 0) {
      console.log('     > ' + c.userPrompts[0].slice(0, 70))
    }
  }

  const highDrift = notImported.filter(c => c.driftScore > 0.5).length
  const medDrift = notImported.filter(c => c.driftScore >= 0.3 && c.driftScore <= 0.5).length
  const lowDrift = notImported.filter(c => c.driftScore < 0.3).length

  console.log('\n=== Summary ===')
  console.log('  Total valid: ' + candidates.length)
  console.log('  Already imported: ' + candidates.filter(c => c.alreadyImported).length)
  console.log('  Not imported: ' + notImported.length)
  console.log('  High drift (>0.5): ' + highDrift)
  console.log('  Medium (0.3-0.5): ' + medDrift)
  console.log('  Low (<0.3): ' + lowDrift)

  if (exportFile) {
    fs.writeFileSync(exportFile, JSON.stringify(notImported.slice(0, topN), null, 2))
    console.log('\n  Exported to ' + exportFile)
  }

  if (autoImport > 0) {
    console.log('\n=== Auto-importing top ' + autoImport + ' ===\n')
    const existing = fs.readdirSync(path.join(process.cwd(), 'eval', 'fixtures'))
      .filter(f => f.match(/^case_\d+\.json$/)).length
    let nextCase = existing + 1

    for (const c of display.slice(0, autoImport)) {
      const num = String(nextCase).padStart(3, '0')
      const out = path.join(process.cwd(), 'eval', 'fixtures', 'case_' + num + '.json')
      const script = c.source === 'claude'
        ? 'scripts/import-claude-transcript.ts'
        : 'scripts/import-openclaw-trajectory.ts'
      try {
        execSync('npx ts-node ' + script + ' "' + c.file + '" "' + out + '"', {
          cwd: process.cwd(), encoding: 'utf-8', stdio: 'pipe',
        })
        console.log('  + case_' + num + ': ' + path.basename(c.file).slice(0, 30) + ' (score=' + c.driftScore.toFixed(2) + ', tools=' + c.toolCalls + ')')
        nextCase++
      } catch {
        console.log('  x Failed: ' + path.basename(c.file).slice(0, 30))
      }
    }
    console.log('\n  Imported ' + (nextCase - existing - 1) + ' new fixtures')
  }
}

function pad(s: string, len: number): string {
  return s.length >= len ? s.slice(0, len) : s + ' '.repeat(len - s.length)
}

main()
