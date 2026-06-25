import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin/tool"

const NEURALWATT_PROVIDER_ID = "neuralwatt"
const NEURALWATT_HOST = "api.neuralwatt.com"

// ============ Types ============

interface ModelStats {
  agent: string
  flexInjected: number
  skipped: number
  apiCalls: number
  tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }
  estimatedCost: number
  energyJoules: number
  energyKwh: number
  carbonG: number
  gridId: string
  actualCost: number
  cacheSavings: number
  lastAllowanceRemaining: number | undefined
}

// ============ State ============

const sessions = new Map<string, Map<string, ModelStats>>()
const disabledModels = new Set<string>()
const sessionInfo = new Map<string, { modelID: string; agent: string }>()
const captureBySession = new Map<string, Array<{ energy?: any; cost?: any }>>()
const captureByModel = new Map<string, Array<{ energy?: any; cost?: any }>>()
const lastTokensByMsg = new Map<string, { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; cost: number }>()

// ============ Helpers ============

function getOrCreateModel(sessionID: string, modelID: string, agent: string): ModelStats {
  if (!sessions.has(sessionID)) sessions.set(sessionID, new Map())
  const sess = sessions.get(sessionID)!
  if (!sess.has(modelID)) {
    sess.set(modelID, {
      agent, flexInjected: 0, skipped: 0, apiCalls: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      estimatedCost: 0, energyJoules: 0, energyKwh: 0, carbonG: 0, gridId: "",
      actualCost: 0, cacheSavings: 0, lastAllowanceRemaining: undefined,
    })
  }
  return sess.get(modelID)!
}

function pad(str: string, len: number): string {
  return str.length >= len ? str : str + " ".repeat(len - str.length)
}

function padR(str: string, len: number): string {
  return str.length >= len ? str : " ".repeat(len - str.length) + str
}

function fmtCost(n: number): string {
  if (n === 0) return "$0"
  if (n < 0.0001) return `$${n.toExponential(2)}`
  if (n < 1) return `$${n.toFixed(5)}`
  return `$${n.toFixed(2)}`
}

function fmtKwh(n: number): string {
  if (n === 0) return "—"
  return `${n.toExponential(2)} kWh`
}

function fmtCarbon(n: number): string {
  if (n === 0) return "—"
  return `${n.toExponential(2)}g`
}

function fmtTokens(n: number): string {
  return n.toLocaleString()
}

function popCapture(sessionID: string, modelID: string): { energy?: any; cost?: any } | undefined {
  const sq = captureBySession.get(sessionID)
  if (sq && sq.length > 0) return sq.shift()
  const mq = captureByModel.get(modelID)
  if (mq && mq.length > 0) return mq.shift()
  return undefined
}

// ============ SSE Parsing ============

function parseSSELine(line: string, captured: { energy?: any; cost?: any }): void {
  const trimmed = line.trim()
  if (!trimmed.startsWith(":")) return
  const m = trimmed.match(/^:\s*(energy|cost)\s+(\{.*\})\s*$/)
  if (!m) return
  try {
    const data = JSON.parse(m[2])
    if (m[1] === "energy") captured.energy = data
    else captured.cost = data
  } catch {}
}

// ============ Fetch Interceptor ============

const _originalFetch = globalThis.fetch
let _patched = false

function patchFetch(): void {
  if (_patched) return
  _patched = true

  globalThis.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    let url = ""
    try {
      if (typeof input === "string") url = input
      else if (input instanceof URL) url = input.href
      else url = (input as Request).url
    } catch {
      return _originalFetch.call(this, input as any, init)
    }

    if (!url.includes(NEURALWATT_HOST) || !url.includes("chat/completions")) {
      return _originalFetch.call(this, input as any, init)
    }

    let modelID: string | undefined
    if (init?.body && typeof init.body === "string") {
      try { modelID = JSON.parse(init.body).model } catch {}
    }

    let sessionID: string | undefined
    if (init?.headers) {
      try {
        const h = init.headers instanceof Headers ? init.headers : new Headers(init.headers as any)
        sessionID = h.get("x-flex-session-id") ?? undefined
      } catch {}
    }

    const response = await _originalFetch.call(this, input as any, init)

    const ct = response.headers.get("content-type") ?? ""
    if (!response.body || !ct.includes("text/event-stream")) return response

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    const captured: { energy?: any; cost?: any } = {}

    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read()
          if (done) {
            if (buffer.trim()) parseSSELine(buffer, captured)
            if ((captured.energy || captured.cost)) {
              const entry = { ...captured }
              if (sessionID) {
                if (!captureBySession.has(sessionID)) captureBySession.set(sessionID, [])
                captureBySession.get(sessionID)!.push(entry)
              } else if (modelID) {
                if (!captureByModel.has(modelID)) captureByModel.set(modelID, [])
                captureByModel.get(modelID)!.push(entry)
              }
            }
            controller.close()
            return
          }
          controller.enqueue(value)
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split("\n")
          buffer = lines.pop() ?? ""
          for (const line of lines) parseSSELine(line, captured)
        } catch (err) {
          controller.error(err)
        }
      },
      cancel(reason) { return reader.cancel(reason) },
    })

    return new Response(stream, { headers: response.headers, status: response.status, statusText: response.statusText })
  } as typeof globalThis.fetch
}

// ============ Formatting ============

const BAR = "=".repeat(78)
const DASH = "─".repeat(78)

function modelTable(models: Map<string, ModelStats>): string[] {
  const lines: string[] = []
  const W = { model: 22, flex: 5, api: 5, tokens: 10, est: 10, act: 12, energy: 14, grid: 5 }
  const hdr = `  ${pad("Model", W.model)} ${padR("Flex", W.flex)} ${padR("API", W.api)} ${padR("Tokens", W.tokens)} ${padR("Est.Cost", W.est)} ${padR("Act.Cost", W.act)} ${padR("Energy", W.energy)} ${pad("Grid", W.grid)}`
  lines.push(hdr)
  lines.push(`  ${DASH.slice(0, hdr.length - 2)}`)

  let tFlex = 0, tApi = 0, tTokens = 0, tEst = 0, tAct = 0, tEnergy = 0
  for (const [modelID, s] of models) {
    const flag = disabledModels.has(modelID) ? " *" : ""
    lines.push(
      `  ${pad(modelID + flag, W.model)} ${padR(String(s.flexInjected), W.flex)} ${padR(String(s.apiCalls), W.api)} ${padR(fmtTokens(s.tokens.input + s.tokens.output + s.tokens.reasoning + s.tokens.cacheRead + s.tokens.cacheWrite), W.tokens)} ${padR(fmtCost(s.estimatedCost), W.est)} ${padR(fmtCost(s.actualCost), W.act)} ${padR(fmtKwh(s.energyKwh), W.energy)} ${pad(s.gridId || "—", W.grid)}`
    )
    tFlex += s.flexInjected; tApi += s.apiCalls
    tTokens += s.tokens.input + s.tokens.output + s.tokens.reasoning + s.tokens.cacheRead + s.tokens.cacheWrite
    tEst += s.estimatedCost; tAct += s.actualCost; tEnergy += s.energyKwh
  }
  lines.push(`  ${DASH.slice(0, hdr.length - 2)}`)
  lines.push(`  ${pad("Total", W.model)} ${padR(String(tFlex), W.flex)} ${padR(String(tApi), W.api)} ${padR(fmtTokens(tTokens), W.tokens)} ${padR(fmtCost(tEst), W.est)} ${padR(fmtCost(tAct), W.act)} ${padR(fmtKwh(tEnergy), W.energy)}`)
  return lines
}

async function getChildSessions(client: any, sessionID: string): Promise<Array<{ id: string; title: string }>> {
  const result: Array<{ id: string; title: string }> = []
  try {
    const resp = await client.session.children({ path: { id: sessionID } })
    const children = (resp as any).data ?? (resp as any) ?? []
    if (Array.isArray(children)) {
      for (const child of children) {
        const id: string = child.id ?? child.info?.id ?? ""
        const title: string = child.title ?? child.info?.title ?? ""
        if (id) {
          result.push({ id, title })
          result.push(...await getChildSessions(client, id))
        }
      }
    }
  } catch {}
  return result
}

async function formatSessionStats(client: any, sessionID: string): Promise<string> {
  const lines: string[] = []
  lines.push(BAR)
  lines.push(`NeuralWatt Flex Stats — Session ${sessionID}`)
  lines.push(BAR)
  lines.push("")

  // Main session
  const mainSession = sessions.get(sessionID)
  if (mainSession && mainSession.size > 0) {
    const agent = mainSession.values().next().value?.agent ?? "unknown"
    lines.push(`Main Session (agent: ${agent}):`)
    lines.push("")
    lines.push(...modelTable(mainSession))
  } else {
    lines.push("Main Session: no NeuralWatt turns yet.")
  }
  lines.push("")

  // Subagents
  const children = await getChildSessions(client, sessionID)
  const childWithStats = children.filter(c => sessions.has(c.id))
  if (childWithStats.length > 0) {
    lines.push(`Subagents (${childWithStats.length} child sessions):`)
    lines.push("")
    const W = { sid: 20, agent: 14, model: 22, flex: 5, api: 5, tokens: 10, act: 12, energy: 14 }
    const hdr = `  ${pad("Session", W.sid)} ${pad("Agent", W.agent)} ${pad("Model", W.model)} ${padR("Flex", W.flex)} ${padR("API", W.api)} ${padR("Tokens", W.tokens)} ${padR("Act.Cost", W.act)} ${padR("Energy", W.energy)}`
    lines.push(hdr)
    lines.push(`  ${DASH.slice(0, hdr.length - 2)}`)

    let tFlex = 0, tApi = 0, tTokens = 0, tAct = 0, tEnergy = 0
    for (const child of childWithStats) {
      const sess = sessions.get(child.id)!
      for (const [modelID, s] of sess) {
        lines.push(
          `  ${pad(child.id, W.sid)} ${pad(s.agent, W.agent)} ${pad(modelID, W.model)} ${padR(String(s.flexInjected), W.flex)} ${padR(String(s.apiCalls), W.api)} ${padR(fmtTokens(s.tokens.input + s.tokens.output + s.tokens.reasoning + s.tokens.cacheRead + s.tokens.cacheWrite), W.tokens)} ${padR(fmtCost(s.actualCost), W.act)} ${padR(fmtKwh(s.energyKwh), W.energy)}`
        )
        tFlex += s.flexInjected; tApi += s.apiCalls
        tTokens += s.tokens.input + s.tokens.output + s.tokens.reasoning + s.tokens.cacheRead + s.tokens.cacheWrite
        tAct += s.actualCost; tEnergy += s.energyKwh
      }
    }
    lines.push(`  ${DASH.slice(0, hdr.length - 2)}`)
    lines.push(`  ${pad("Subtotal", W.sid + W.agent + W.model + 2)} ${padR(String(tFlex), W.flex)} ${padR(String(tApi), W.api)} ${padR(fmtTokens(tTokens), W.tokens)} ${padR(fmtCost(tAct), W.act)} ${padR(fmtKwh(tEnergy), W.energy)}`)
    lines.push("")
  }

  // Combined totals
  let cFlex = 0, cApi = 0, cTokens = 0, cEst = 0, cAct = 0, cEnergy = 0, cCarbon = 0
  let cGrid = ""
  const allSessions = [sessionID, ...children.map(c => c.id)]
  for (const sid of allSessions) {
    const sess = sessions.get(sid)
    if (!sess) continue
    for (const s of sess.values()) {
      cFlex += s.flexInjected; cApi += s.apiCalls
      cTokens += s.tokens.input + s.tokens.output + s.tokens.reasoning + s.tokens.cacheRead + s.tokens.cacheWrite
      cEst += s.estimatedCost; cAct += s.actualCost
      cEnergy += s.energyKwh; cCarbon += s.carbonG
      if (s.gridId) cGrid = s.gridId
    }
  }
  lines.push(`Combined: ${cFlex} flex turns (${cApi} API calls)  ${fmtTokens(cTokens)} tokens`)
  lines.push(`  Estimated cost (models.dev): ${fmtCost(cEst)}`)
  lines.push(`  Actual billed cost (NeuralWatt): ${fmtCost(cAct)}`)
  if (cEnergy > 0) {
    lines.push(`  Energy: ${fmtKwh(cEnergy)}  Carbon: ${fmtCarbon(cCarbon)}  Grid: ${cGrid || "—"}`)
  }
  const lastAllowance = [...allSessions].reverse().map(sid => sessions.get(sid)).filter(Boolean).flatMap(s => [...s!.values()].map(m => m.lastAllowanceRemaining)).find(v => v !== undefined)
  if (lastAllowance !== undefined) {
    lines.push(`  Allowance remaining: ${fmtCost(lastAllowance)}`)
  }

  lines.push("")
  lines.push(`Disabled models: ${disabledModels.size === 0 ? "(none)" : [...disabledModels].join(", ")}`)
  if (disabledModels.size > 0) lines.push("  (* = disabled for flex injection)")
  lines.push("")
  lines.push(BAR)
  lines.push('Note: "Est.Cost" = opencode models.dev estimate (no flex discount).')
  lines.push('"Act.Cost" = NeuralWatt actual billed cost (includes flex discount).')
  lines.push(BAR)
  return lines.join("\n")
}

function formatOverallStats(): string {
  const lines: string[] = []
  lines.push(BAR)
  lines.push("NeuralWatt Flex Stats — Process Lifetime")
  lines.push(BAR)
  lines.push("")

  // Aggregate by agent × model
  const agg = new Map<string, ModelStats>()
  for (const [, models] of sessions) {
    for (const [modelID, s] of models) {
      const key = `${s.agent}\u0000${modelID}`
      const existing = agg.get(key)
      if (existing) {
        existing.flexInjected += s.flexInjected
        existing.skipped += s.skipped
        existing.apiCalls += s.apiCalls
        existing.tokens.input += s.tokens.input
        existing.tokens.output += s.tokens.output
        existing.tokens.reasoning += s.tokens.reasoning
        existing.tokens.cacheRead += s.tokens.cacheRead
        existing.tokens.cacheWrite += s.tokens.cacheWrite
        existing.estimatedCost += s.estimatedCost
        existing.energyJoules += s.energyJoules
        existing.energyKwh += s.energyKwh
        existing.carbonG += s.carbonG
        existing.actualCost += s.actualCost
        existing.cacheSavings += s.cacheSavings
        if (s.lastAllowanceRemaining !== undefined) existing.lastAllowanceRemaining = s.lastAllowanceRemaining
      } else {
        agg.set(key, { ...s, tokens: { ...s.tokens } })
      }
    }
  }

  if (agg.size === 0) {
    lines.push("No NeuralWatt turns recorded yet.")
    lines.push("")
    lines.push(BAR)
    return lines.join("\n")
  }

  const W = { agent: 14, model: 22, flex: 5, api: 5, sess: 8, tokens: 10, est: 10, act: 12, energy: 14 }
  const hdr = `  ${pad("Agent", W.agent)} ${pad("Model", W.model)} ${padR("Flex", W.flex)} ${padR("API", W.api)} ${padR("Sess", W.sess)} ${padR("Tokens", W.tokens)} ${padR("Est.Cost", W.est)} ${padR("Act.Cost", W.act)} ${padR("Energy", W.energy)}`
  lines.push(hdr)
  lines.push(`  ${DASH.slice(0, hdr.length - 2)}`)

  const sessionCountByAgentModel = new Map<string, Set<string>>()
  for (const [sid, models] of sessions) {
    for (const [modelID, s] of models) {
      const key = `${s.agent}\u0000${modelID}`
      if (!sessionCountByAgentModel.has(key)) sessionCountByAgentModel.set(key, new Set())
      sessionCountByAgentModel.get(key)!.add(sid)
    }
  }

  let tFlex = 0, tApi = 0, tTokens = 0, tEst = 0, tAct = 0, tEnergy = 0, tCarbon = 0
  let tGrid = ""
  const sorted = [...agg.entries()].sort((a, b) => b[1].flexInjected - a[1].flexInjected)
  for (const [key, s] of sorted) {
    const [agent, modelID] = key.split("\u0000")
    const sessCount = sessionCountByAgentModel.get(key)?.size ?? 0
    const flag = disabledModels.has(modelID) ? " *" : ""
    lines.push(
      `  ${pad(agent, W.agent)} ${pad(modelID + flag, W.model)} ${padR(String(s.flexInjected), W.flex)} ${padR(String(s.apiCalls), W.api)} ${padR(String(sessCount), W.sess)} ${padR(fmtTokens(s.tokens.input + s.tokens.output + s.tokens.reasoning + s.tokens.cacheRead + s.tokens.cacheWrite), W.tokens)} ${padR(fmtCost(s.estimatedCost), W.est)} ${padR(fmtCost(s.actualCost), W.act)} ${padR(fmtKwh(s.energyKwh), W.energy)}`
    )
    tFlex += s.flexInjected; tApi += s.apiCalls
    tTokens += s.tokens.input + s.tokens.output + s.tokens.reasoning + s.tokens.cacheRead + s.tokens.cacheWrite
    tEst += s.estimatedCost; tAct += s.actualCost
    tEnergy += s.energyKwh; tCarbon += s.carbonG
    if (s.gridId) tGrid = s.gridId
  }
  lines.push(`  ${DASH.slice(0, hdr.length - 2)}`)
  lines.push(`  ${pad("Total", W.agent + W.model + 1)} ${padR(String(tFlex), W.flex)} ${padR(String(tApi), W.api)} ${padR(String(sessions.size), W.sess)} ${padR(fmtTokens(tTokens), W.tokens)} ${padR(fmtCost(tEst), W.est)} ${padR(fmtCost(tAct), W.act)} ${padR(fmtKwh(tEnergy), W.energy)}`)

  const totalSkipped = [...sessions.values()].flatMap(m => [...m.values()]).reduce((sum, s) => sum + s.skipped, 0)
  const totalTurns = tFlex + totalSkipped
  const flexRate = totalTurns > 0 ? ((tFlex / totalTurns) * 100).toFixed(1) : "0.0"
  lines.push(`  Flex rate: ${flexRate}%`)

  if (tEnergy > 0) {
    lines.push(`  Energy: ${fmtKwh(tEnergy)}  Carbon: ${fmtCarbon(tCarbon)}  Grid: ${tGrid || "—"}`)
  }

  // Last known allowance
  let lastAllowance: number | undefined
  for (const s of agg.values()) {
    if (s.lastAllowanceRemaining !== undefined) lastAllowance = s.lastAllowanceRemaining
  }
  if (lastAllowance !== undefined) {
    lines.push(`  Allowance remaining: ${fmtCost(lastAllowance)}`)
  }

  lines.push("")
  lines.push(`Disabled models: ${disabledModels.size === 0 ? "(none)" : [...disabledModels].join(", ")}`)
  if (disabledModels.size > 0) lines.push("  (* = disabled for flex injection)")
  lines.push("")
  lines.push(BAR)
  lines.push('Note: "Est.Cost" = opencode models.dev estimate (no flex discount).')
  lines.push('"Act.Cost" = NeuralWatt actual billed cost (includes flex discount).')
  lines.push("Energy/carbon from NeuralWatt SSE telemetry.")
  lines.push(BAR)
  return lines.join("\n")
}

// ============ Plugin ============

export default (async ({ client }) => {
  patchFetch()

  return {
    "chat.params": async (input, output) => {
      const providerID = input.provider?.info?.id ?? input.model?.providerID
      if (providerID !== NEURALWATT_PROVIDER_ID) return

      const modelID = input.model?.modelID ?? "unknown"
      const sessionID = input.sessionID ?? "unknown"
      const agent = input.agent ?? "unknown"

      sessionInfo.set(sessionID, { modelID, agent })

      const stats = getOrCreateModel(sessionID, modelID, agent)

      if (disabledModels.has(modelID)) {
        stats.skipped++
        return
      }

      output.options.service_tier = "flex"
      stats.flexInjected++
    },

    "chat.headers": async (input, output) => {
      const providerID = input.provider?.info?.id ?? input.model?.providerID
      if (providerID !== NEURALWATT_PROVIDER_ID) return
      output.headers["x-flex-session-id"] = input.sessionID ?? "unknown"
    },

    event: async ({ event }) => {
      if (event.type === "message.updated") {
        const info = (event as any).properties?.info
        if (!info || info.role !== "assistant") return

        const providerID: string = info.providerID
        if (providerID !== NEURALWATT_PROVIDER_ID) return

        const msgID: string = info.id
        const sessionID: string = info.sessionID
        const modelID: string = info.modelID

        const current = {
          input: info.tokens?.input ?? 0,
          output: info.tokens?.output ?? 0,
          reasoning: info.tokens?.reasoning ?? 0,
          cacheRead: info.tokens?.cache?.read ?? 0,
          cacheWrite: info.tokens?.cache?.write ?? 0,
          cost: info.cost ?? 0,
        }

        const last = lastTokensByMsg.get(msgID) ?? { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }

        const dInput = current.input - last.input
        const dOutput = current.output - last.output
        const dReasoning = current.reasoning - last.reasoning
        const dCacheRead = current.cacheRead - last.cacheRead
        const dCacheWrite = current.cacheWrite - last.cacheWrite
        const dCost = current.cost - last.cost

        if (dInput !== 0 || dOutput !== 0 || dCost !== 0 || dReasoning !== 0 || dCacheRead !== 0 || dCacheWrite !== 0) {
          const sInfo = sessionInfo.get(sessionID)
          const agent = sInfo?.agent ?? "unknown"
          const stats = getOrCreateModel(sessionID, modelID, agent)

          stats.apiCalls++
          stats.tokens.input += dInput
          stats.tokens.output += dOutput
          stats.tokens.reasoning += dReasoning
          stats.tokens.cacheRead += dCacheRead
          stats.tokens.cacheWrite += dCacheWrite
          stats.estimatedCost += dCost

          const cap = popCapture(sessionID, modelID)
          if (cap) {
            if (cap.energy) {
              const e = cap.energy
              stats.energyJoules += e.energy_joules ?? 0
              stats.energyKwh += e.energy_kwh ?? 0
              stats.carbonG += e.carbon_g_co2eq ?? 0
              if (e.grid_id) stats.gridId = e.grid_id
            }
            if (cap.cost) {
              const c = cap.cost
              stats.actualCost += c.request_cost_usd ?? 0
              stats.cacheSavings += c.cache_savings_usd ?? 0
              stats.lastAllowanceRemaining = c.allowance_remaining_usd
            }
          }
        }

        lastTokensByMsg.set(msgID, { ...current })
        return
      }

      if (event.type === "session.error") {
        const props = (event as any).properties
        if (!props) return
        const errorStr = JSON.stringify(props).toLowerCase()
        if (!errorStr.includes("flex") && !errorStr.includes("service_tier")) return

        const error = props.error
        const modelID = error?.data?.modelID ?? error?.modelID
        if (modelID) {
          disabledModels.add(modelID)
          try {
            await client.app.log({
              body: { service: "neuralwatt-flex", level: "warn", message: `Disabled flex for ${modelID}` },
            })
          } catch {}
        }
      }
    },

    tool: {
      "flex-session": tool({
        description:
          "Show NeuralWatt flex stats for the current session and all subagent child sessions. Per-agent per-model breakdown with flex injection counts, API calls, tokens, estimated cost (models.dev), actual billed cost (NeuralWatt), energy, and carbon emissions.",
        args: {},
        async execute(_args, context) {
          const sessionID = context.sessionID ?? "unknown"
          return await formatSessionStats(client, sessionID)
        },
      }),
      "flex-stats": tool({
        description:
          "Show overall NeuralWatt flex stats across all sessions in the process lifetime, broken down by agent and model. Includes flex injection counts, API calls, tokens, estimated cost, actual billed cost, energy, and carbon.",
        args: {},
        async execute() {
          return formatOverallStats()
        },
      }),
    },
  }
}) satisfies Plugin
