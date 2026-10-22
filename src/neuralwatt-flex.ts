/**
 * neuralwatt-flex — OpenCode V2 plugin
 *
 * Silently routes NeuralWatt traffic onto cheaper, lower-priority flex
 * capacity (`service_tier: "flex"`) whenever it's available, and reports
 * per-session usage, cost, energy and carbon telemetry.
 *
 * Ported from the OpenCode V1 plugin API to the V2 plugin API
 * (`Plugin.define`-style `{ id, setup(ctx) }` entrypoint).
 */
import type { Plugin } from "@opencode/plugin"
import type { SessionContext } from "@opencode/plugin/promise/session"

const NEURALWATT_PROVIDER_ID = "neuralwatt"
const NEURALWATT_HOST = "api.neuralwatt.com"

// ============ Types ============

type Tier = "flex" | "std"

interface ModelStats {
  agent: string
  tier: Tier
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

interface ModelTiers {
  flex: ModelStats
  std: ModelStats
}

// ============ State ============

const sessions = new Map<string, Map<string, ModelTiers>>()
const disabledModels = new Set<string>()
const sessionInfo = new Map<string, { modelID: string; agent: string; flex: boolean }>()
const captureBySession = new Map<string, Array<{ energy?: any; cost?: any }>>()

// ============ Helpers ============

function newStats(agent: string, tier: Tier): ModelStats {
  return {
    agent, tier, skipped: 0, apiCalls: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    estimatedCost: 0, energyJoules: 0, energyKwh: 0, carbonG: 0, gridId: "",
    actualCost: 0, cacheSavings: 0, lastAllowanceRemaining: undefined,
  }
}

function getOrCreateModel(sessionID: string, modelID: string, agent: string, flex: boolean): ModelStats {
  if (!sessions.has(sessionID)) sessions.set(sessionID, new Map())
  const sess = sessions.get(sessionID)!
  let tiers = sess.get(modelID)
  if (!tiers) {
    tiers = { flex: newStats(agent, "flex"), std: newStats(agent, "std") }
    sess.set(modelID, tiers)
  }
  return flex ? tiers.flex : tiers.std
}

function tokenTotal(s: ModelStats): number {
  return s.tokens.input + s.tokens.output + s.tokens.reasoning + s.tokens.cacheRead + s.tokens.cacheWrite
}

function hasActivity(s: ModelStats): boolean {
  return s.apiCalls > 0 || s.skipped > 0 || tokenTotal(s) > 0 || s.actualCost > 0 || s.energyKwh > 0
}

function tierLabel(modelID: string, tier: Tier): string {
  return tier === "flex" ? modelID : `${modelID} [std]`
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

function popCapture(sessionID: string): { energy?: any; cost?: any } | undefined {
  const queue = captureBySession.get(sessionID)
  if (queue && queue.length > 0) return queue.shift()
  return undefined
}

function addInto(dst: ModelStats, src: ModelStats): void {
  dst.skipped += src.skipped
  dst.apiCalls += src.apiCalls
  dst.tokens.input += src.tokens.input
  dst.tokens.output += src.tokens.output
  dst.tokens.reasoning += src.tokens.reasoning
  dst.tokens.cacheRead += src.tokens.cacheRead
  dst.tokens.cacheWrite += src.tokens.cacheWrite
  dst.estimatedCost += src.estimatedCost
  dst.energyJoules += src.energyJoules
  dst.energyKwh += src.energyKwh
  dst.carbonG += src.carbonG
  dst.actualCost += src.actualCost
  dst.cacheSavings += src.cacheSavings
  if (src.lastAllowanceRemaining !== undefined) dst.lastAllowanceRemaining = src.lastAllowanceRemaining
  if (src.gridId) dst.gridId = src.gridId
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

/**
 * Wrap a streaming provider Response with a tee'd copy that watches for
 * NeuralWatt's `:energy` / `:cost` SSE comment lines and queues them for the
 * next per-step accounting pass on that session.
 */
function interceptResponse(sessionID: string, response: Response): Response {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const captured: { energy?: any; cost?: any } = {}

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          if (buffer.trim()) parseSSELine(buffer, captured)
          if (captured.energy || captured.cost) {
            if (!captureBySession.has(sessionID)) captureBySession.set(sessionID, [])
            captureBySession.get(sessionID)!.push({ ...captured })
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
}

// ============ Session tree ============

async function getChildSessions(ctx: Plugin.Context, sessionID: string): Promise<Array<{ id: string; title: string }>> {
  const result: Array<{ id: string; title: string }> = []
  try {
    const page: any = await ctx.session.list({ parentID: sessionID, limit: 100 })
    const children: any[] = page?.data ?? (Array.isArray(page) ? page : [])
    for (const child of children) {
      const id: string = child?.id ?? ""
      if (!id) continue
      result.push({ id, title: child?.title ?? "" })
      result.push(...(await getChildSessions(ctx, id)))
    }
  } catch {}
  return result
}

// ============ Formatting ============

const BAR = "=".repeat(78)
const DASH = "─".repeat(78)

function modelTierRows(label: string, s: ModelStats, W: { model: number; api: number; tokens: number; est: number; act: number; energy: number; grid: number }): { line: string; active: boolean } {
  if (!hasActivity(s)) return { line: "", active: false }
  const flag = s.tier === "std" && disabledModels.has(label.split(" [")[0]) ? " *" : ""
  const line =
    `  ${pad(tierLabel(label, s.tier) + flag, W.model)} ${padR(String(s.apiCalls), W.api)} ${padR(fmtTokens(tokenTotal(s)), W.tokens)} ${padR(fmtCost(s.estimatedCost), W.est)} ${padR(fmtCost(s.actualCost), W.act)} ${padR(fmtKwh(s.energyKwh), W.energy)} ${pad(s.gridId || "—", W.grid)}`
  return { line, active: true }
}

function modelTable(models: Map<string, ModelTiers>): string[] {
  const lines: string[] = []
  const W = { model: 24, api: 5, tokens: 10, est: 10, act: 12, energy: 14, grid: 5 }
  const hdr = `  ${pad("Model", W.model)} ${padR("API", W.api)} ${padR("Tokens", W.tokens)} ${padR("Est.Cost", W.est)} ${padR("Act.Cost", W.act)} ${padR("Energy", W.energy)} ${pad("Grid", W.grid)}`
  lines.push(hdr)
  lines.push(`  ${DASH.slice(0, hdr.length - 2)}`)

  let tApi = 0, tTokens = 0, tEst = 0, tAct = 0, tEnergy = 0
  for (const [modelID, tiers] of models) {
    for (const s of [tiers.flex, tiers.std]) {
      const row = modelTierRows(modelID, s, W)
      if (!row.active) continue
      lines.push(row.line)
      tApi += s.apiCalls; tTokens += tokenTotal(s)
      tEst += s.estimatedCost; tAct += s.actualCost; tEnergy += s.energyKwh
    }
  }
  lines.push(`  ${DASH.slice(0, hdr.length - 2)}`)
  lines.push(`  ${pad("Total", W.model)} ${padR(String(tApi), W.api)} ${padR(fmtTokens(tTokens), W.tokens)} ${padR(fmtCost(tEst), W.est)} ${padR(fmtCost(tAct), W.act)} ${padR(fmtKwh(tEnergy), W.energy)}`)
  return lines
}

async function formatSessionStats(ctx: Plugin.Context, sessionID: string): Promise<string> {
  const lines: string[] = []
  lines.push(BAR)
  lines.push(`NeuralWatt Flex Stats — Session ${sessionID}`)
  lines.push(BAR)
  lines.push("")

  // Main session
  const mainSession = sessions.get(sessionID)
  if (mainSession && mainSession.size > 0) {
    const agent = mainSession.values().next().value?.flex.agent ?? "unknown"
    lines.push(`Main Session (agent: ${agent}):`)
    lines.push("")
    lines.push(...modelTable(mainSession))
  } else {
    lines.push("Main Session: no NeuralWatt turns yet.")
  }
  lines.push("")

  // Subagents
  const children = await getChildSessions(ctx, sessionID)
  const childWithStats = children.filter(c => sessions.has(c.id))
  if (childWithStats.length > 0) {
    lines.push(`Subagents (${childWithStats.length} child sessions):`)
    lines.push("")
    const W = { sid: 20, agent: 14, model: 24, api: 5, tokens: 10, act: 12, energy: 14 }
    const hdr = `  ${pad("Session", W.sid)} ${pad("Agent", W.agent)} ${pad("Model", W.model)} ${padR("API", W.api)} ${padR("Tokens", W.tokens)} ${padR("Act.Cost", W.act)} ${padR("Energy", W.energy)}`
    lines.push(hdr)
    lines.push(`  ${DASH.slice(0, hdr.length - 2)}`)

    let tApi = 0, tTokens = 0, tAct = 0, tEnergy = 0
    for (const child of childWithStats) {
      const sess = sessions.get(child.id)!
      for (const [modelID, tiers] of sess) {
        for (const s of [tiers.flex, tiers.std]) {
          if (!hasActivity(s)) continue
          const flag = s.tier === "std" && disabledModels.has(modelID) ? " *" : ""
          lines.push(
            `  ${pad(child.id, W.sid)} ${pad(s.agent, W.agent)} ${pad(tierLabel(modelID, s.tier) + flag, W.model)} ${padR(String(s.apiCalls), W.api)} ${padR(fmtTokens(tokenTotal(s)), W.tokens)} ${padR(fmtCost(s.actualCost), W.act)} ${padR(fmtKwh(s.energyKwh), W.energy)}`
          )
          tApi += s.apiCalls; tTokens += tokenTotal(s)
          tAct += s.actualCost; tEnergy += s.energyKwh
        }
      }
    }
    lines.push(`  ${DASH.slice(0, hdr.length - 2)}`)
    lines.push(`  ${pad("Subtotal", W.sid + W.agent + W.model + 2)} ${padR(String(tApi), W.api)} ${padR(fmtTokens(tTokens), W.tokens)} ${padR(fmtCost(tAct), W.act)} ${padR(fmtKwh(tEnergy), W.energy)}`)
    lines.push("")
  }

  // Combined totals
  let fApi = 0, fTokens = 0, fEst = 0, fAct = 0, fEnergy = 0, fCarbon = 0
  let sApi = 0, sTokens = 0, sEst = 0, sAct = 0
  let cEnergy = 0, cCarbon = 0
  let cGrid = ""
  const allSessions = [sessionID, ...children.map(c => c.id)]
  for (const sid of allSessions) {
    const sess = sessions.get(sid)
    if (!sess) continue
    for (const tiers of sess.values()) {
      const f = tiers.flex, st = tiers.std
      fApi += f.apiCalls; fTokens += tokenTotal(f); fEst += f.estimatedCost; fAct += f.actualCost
      sApi += st.apiCalls; sTokens += tokenTotal(st); sEst += st.estimatedCost; sAct += st.actualCost
      cEnergy += f.energyKwh + st.energyKwh; cCarbon += f.carbonG + st.carbonG
      if (f.gridId) cGrid = f.gridId
      if (st.gridId) cGrid = st.gridId
    }
  }
  const totalApi = fApi + sApi, totalTokens = fTokens + sTokens, totalEst = fEst + sEst, totalAct = fAct + sAct
  lines.push(`Combined: ${totalApi} turns (${fmtTokens(totalTokens)} tokens)`)
  lines.push(`  Flex:        ${fApi} turns  ${fmtTokens(fTokens)} tokens   Est ${fmtCost(fEst)}   Billed ${fmtCost(fAct)}`)
  lines.push(`  Non-flex:    ${sApi} turns  ${fmtTokens(sTokens)} tokens   Est ${fmtCost(sEst)}   Billed ${fmtCost(sAct)}`)
  lines.push(`  Estimated cost (opencode): ${fmtCost(totalEst)}`)
  lines.push(`  Actual billed cost (NeuralWatt): ${fmtCost(totalAct)}`)
  if (cEnergy > 0) {
    lines.push(`  Energy: ${fmtKwh(cEnergy)}  Carbon: ${fmtCarbon(cCarbon)}  Grid: ${cGrid || "—"}`)
  }
  const lastAllowance = [...allSessions].reverse().map(sid => sessions.get(sid)).filter(Boolean).flatMap(s => [...s!.values()].flatMap(t => [t.flex, t.std]).map(m => m.lastAllowanceRemaining)).find(v => v !== undefined)
  if (lastAllowance !== undefined) {
    lines.push(`  Allowance remaining: ${fmtCost(lastAllowance)}`)
  }

  lines.push("")
  lines.push(`Disabled models: ${disabledModels.size === 0 ? "(none)" : [...disabledModels].join(", ")}`)
  if (disabledModels.size > 0) lines.push("  (* = std tier, flex disabled for that model)")
  lines.push("")
  lines.push(BAR)
  lines.push('Note: "Flex" = runs on flex capacity (discounted). "[std]" = non-flex fallback runs.')
  lines.push('"Est.Cost" = opencode cost estimate (list price). "Billed" = NeuralWatt actual.')
  lines.push(BAR)
  return lines.join("\n")
}

function formatOverallStats(): string {
  const lines: string[] = []
  lines.push(BAR)
  lines.push("NeuralWatt Flex Stats — Process Lifetime")
  lines.push(BAR)
  lines.push("")

  // Aggregate by agent × model × tier
  const agg = new Map<string, ModelStats>()
  for (const [, models] of sessions) {
    for (const [modelID, tiers] of models) {
      for (const s of [tiers.flex, tiers.std]) {
        const key = `${s.agent}\u0000${modelID}\u0000${s.tier}`
        const existing = agg.get(key)
        if (existing) addInto(existing, s)
        else agg.set(key, { ...s, tokens: { ...s.tokens } })
      }
    }
  }

  if (agg.size === 0) {
    lines.push("No NeuralWatt turns recorded yet.")
    lines.push("")
    lines.push(BAR)
    return lines.join("\n")
  }

  const W = { agent: 14, model: 24, api: 5, sess: 8, tokens: 10, est: 10, act: 12, energy: 14 }
  const hdr = `  ${pad("Agent", W.agent)} ${pad("Model", W.model)} ${padR("API", W.api)} ${padR("Sess", W.sess)} ${padR("Tokens", W.tokens)} ${padR("Est.Cost", W.est)} ${padR("Act.Cost", W.act)} ${padR("Energy", W.energy)}`
  lines.push(hdr)
  lines.push(`  ${DASH.slice(0, hdr.length - 2)}`)

  const sessionCountByAgentModelTier = new Map<string, Set<string>>()
  for (const [sid, models] of sessions) {
    for (const [modelID, tiers] of models) {
      for (const s of [tiers.flex, tiers.std]) {
        const key = `${s.agent}\u0000${modelID}\u0000${s.tier}`
        if (!sessionCountByAgentModelTier.has(key)) sessionCountByAgentModelTier.set(key, new Set())
        sessionCountByAgentModelTier.get(key)!.add(sid)
      }
    }
  }

  let tApi = 0, tTokens = 0, tEst = 0, tAct = 0, tEnergy = 0, tCarbon = 0
  let fApi = 0, sApi = 0, fEst = 0, sEst = 0, fAct = 0, sAct = 0
  let tGrid = ""
  const sorted = [...agg.entries()].sort((a, b) => b[1].apiCalls - a[1].apiCalls)
  for (const [key, s] of sorted) {
    if (!hasActivity(s)) continue
    const [agent, modelID] = key.split("\u0000")
    const sessCount = sessionCountByAgentModelTier.get(key)?.size ?? 0
    const flag = s.tier === "std" && disabledModels.has(modelID) ? " *" : ""
    lines.push(
      `  ${pad(agent, W.agent)} ${pad(tierLabel(modelID, s.tier) + flag, W.model)} ${padR(String(s.apiCalls), W.api)} ${padR(String(sessCount), W.sess)} ${padR(fmtTokens(tokenTotal(s)), W.tokens)} ${padR(fmtCost(s.estimatedCost), W.est)} ${padR(fmtCost(s.actualCost), W.act)} ${padR(fmtKwh(s.energyKwh), W.energy)}`
    )
    tApi += s.apiCalls; tTokens += tokenTotal(s)
    tEst += s.estimatedCost; tAct += s.actualCost
    tEnergy += s.energyKwh; tCarbon += s.carbonG
    if (s.gridId) tGrid = s.gridId
    if (s.tier === "flex") { fApi += s.apiCalls; fEst += s.estimatedCost; fAct += s.actualCost }
    else { sApi += s.apiCalls; sEst += s.estimatedCost; sAct += s.actualCost }
  }
  lines.push(`  ${DASH.slice(0, hdr.length - 2)}`)
  lines.push(`  ${pad("Total", W.agent + W.model + 1)} ${padR(String(tApi), W.api)} ${padR(String(sessions.size), W.sess)} ${padR(fmtTokens(tTokens), W.tokens)} ${padR(fmtCost(tEst), W.est)} ${padR(fmtCost(tAct), W.act)} ${padR(fmtKwh(tEnergy), W.energy)}`)

  const flexRate = tApi > 0 ? ((fApi / tApi) * 100).toFixed(1) : "0.0"
  lines.push(`  Flex rate: ${flexRate}%  (${fApi} flex / ${sApi} non-flex turns)`)
  lines.push(`  Flex billed: ${fmtCost(fAct)}   Non-flex billed: ${fmtCost(sAct)}`)

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
  if (disabledModels.size > 0) lines.push("  (* = std tier, flex disabled for that model)")
  lines.push("")
  lines.push(BAR)
  lines.push('Note: "Flex" = runs on flex capacity (discounted). "[std]" = non-flex fallback runs.')
  lines.push('"Est.Cost" = opencode cost estimate (list price). "Act.Cost" = NeuralWatt actual.')
  lines.push("Energy/carbon from NeuralWatt SSE telemetry.")
  lines.push(BAR)
  return lines.join("\n")
}

// ============ Plugin ============

export default {
  id: "neuralwatt-flex",

  async setup(ctx) {
    // ---- 1. Flex injection + per-session bookkeeping -----------------
    // `context` runs for the agent loop, `compaction` and `generate` for the
    // auxiliary model requests V1 also flexed. Title generation is excluded,
    // matching V1 behaviour.
    const onModelContext = (event: SessionContext): void => {
      if (event?.model?.providerID !== NEURALWATT_PROVIDER_ID) return

      const modelID: string = event.model?.id ?? "unknown"
      const agent: string = event.agent ?? "unknown"
      const sessionID: string = event.sessionID ?? "unknown"

      const isFlex = !disabledModels.has(modelID)
      sessionInfo.set(sessionID, { modelID, agent, flex: isFlex })

      if (!isFlex) {
        getOrCreateModel(sessionID, modelID, agent, false).skipped++
        return
      }

      event.options.service_tier = "flex"
    }
    await ctx.session.hook("context", onModelContext, { providerID: NEURALWATT_PROVIDER_ID })
    await ctx.session.hook("compaction", onModelContext, { providerID: NEURALWATT_PROVIDER_ID })
    await ctx.session.hook("generate", onModelContext, { providerID: NEURALWATT_PROVIDER_ID })

    // ---- 2. Guaranteed request-body injection + correlation header ----
    // The `service_tier` provider option above is the semantic path; this
    // hook enforces the field on the final HTTP body no matter how the
    // protocol lowers options, and tags the request with the session id so
    // NeuralWatt telemetry can be correlated back.
    await ctx.session.hook("http.request", async (event) => {
      const request = event.request
      let url = ""
      try { url = new URL(request.url).href } catch { return }
      if (!url.includes(NEURALWATT_HOST) || !url.includes("chat/completions")) return

      try { request.headers.set("x-flex-session-id", event.sessionID) } catch {}

      let body: any
      try {
        const text = await request.clone().text()
        body = text ? JSON.parse(text) : {}
        if (!body || typeof body !== "object") return
      } catch { return }

      const modelID = typeof body.model === "string" ? body.model : undefined
      if (modelID && disabledModels.has(modelID)) {
        if (body.service_tier !== undefined) {
          delete body.service_tier
          try { event.request = new Request(request, { body: JSON.stringify(body) }) } catch {}
        }
        return
      }
      if (body.service_tier !== "flex") {
        body.service_tier = "flex"
        try { event.request = new Request(request, { body: JSON.stringify(body) }) } catch {}
      }
    }, { providerID: NEURALWATT_PROVIDER_ID })

    // ---- 3. Telemetry capture from the SSE stream ---------------------
    await ctx.session.hook("http.response", (event) => {
      const response = event.response
      const ct = response.headers.get("content-type") ?? ""
      if (!response.body || !ct.includes("text/event-stream")) return
      event.response = interceptResponse(event.sessionID, response)
    }, { providerID: NEURALWATT_PROVIDER_ID })

    // ---- 4. Event stream: per-step accounting + error fallback ---------
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const ev of ctx.event.subscribe({ signal: controller.signal })) {
          if (ev.type === "session.step.ended" || ev.type === "session.step.failed") {
            const data = (ev as any).data
            const sessionID: string | undefined = data?.sessionID
            if (!sessionID) continue

            // Only NeuralWatt sessions are tracked (the context hook above
            // registers them); keeps other providers out of the stats.
            const sInfo = sessionInfo.get(sessionID)
            if (!sInfo) continue

            const tokens = data.tokens
            const cost = typeof data.cost === "number" ? data.cost : 0
            if (!tokens && !cost) continue

            const stats = getOrCreateModel(sessionID, sInfo.modelID, sInfo.agent, sInfo.flex)
            stats.apiCalls++
            if (tokens) {
              stats.tokens.input += tokens.input ?? 0
              stats.tokens.output += tokens.output ?? 0
              stats.tokens.reasoning += tokens.reasoning ?? 0
              stats.tokens.cacheRead += tokens.cache?.read ?? 0
              stats.tokens.cacheWrite += tokens.cache?.write ?? 0
            }
            stats.estimatedCost += cost

            const cap = popCapture(sessionID)
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

          if (ev.type === "session.step.failed" || ev.type === "session.execution.failed") {
            const data = (ev as any).data
            const error = data?.error
            if (!error || !data?.sessionID) continue

            const errorStr = JSON.stringify(error).toLowerCase()
            if (!errorStr.includes("flex") && !errorStr.includes("service_tier")) continue

            const sInfo = sessionInfo.get(data.sessionID)
            const modelID = sInfo?.modelID
            if (modelID && !disabledModels.has(modelID)) {
              disabledModels.add(modelID)
              console.warn(`[neuralwatt-flex] Disabled flex for ${modelID}`)
            }
          }
        }
      } catch (err: any) {
        if (err?.name !== "AbortError") {
          console.error("[neuralwatt-flex] event subscription failed:", err)
        }
      }
    })()

    // ---- 5. Reporting tools -------------------------------------------
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "flex-session",
        description:
          "Show NeuralWatt flex stats for the current session and all subagent child sessions. Per-model breakdown split into flex (discounted) and non-flex (std fallback) tiers, with API calls, tokens, estimated cost, actual billed cost (NeuralWatt), energy, and carbon emissions.",
        options: { codemode: false },
        input: { type: "object", properties: {}, additionalProperties: false },
        async execute(_input, context) {
          const sessionID = context.sessionID ?? "unknown"
          return { content: await formatSessionStats(ctx, sessionID) }
        },
      })
      editor.add({
        name: "flex-stats",
        description:
          "Show overall NeuralWatt flex stats across all sessions in the process lifetime, broken down by agent, model, and tier (flex vs non-flex). Includes API calls, tokens, estimated cost, actual billed cost, flex rate, energy, and carbon.",
        options: { codemode: false },
        input: { type: "object", properties: {}, additionalProperties: false },
        async execute() {
          return { content: formatOverallStats() }
        },
      })
    })

    return () => controller.abort()
  },
} satisfies Plugin.Plugin
