import {
  NoCapacityError,
  atomicToUsdc,
  type NodeRecord,
  normalizeModelId,
  type NodeSelection,
} from "@x402-mesh/shared";
import type { NodeStore } from "../store/types.js";
import { DEFAULT_WEIGHTS, nodePriceAtomic, scoreNode, type ScoreWeights } from "./score.js";

/**
 * Routes an inference request to a node.
 *
 * Selection is a two-stage pipeline: a hard **eligibility filter** that no score can override,
 * then a **weighted random draw** over the survivors. The draw — rather than taking the argmax —
 * is what keeps the mesh a mesh: a single best node would otherwise absorb every request until
 * it saturated, its latency would degrade, and traffic would stampede to the next node in turn.
 * Spreading load proportionally to score keeps every node's health window fresh, which is also
 * the only way the registry learns that a recovering node is healthy again.
 */

/** Baseline weight every candidate receives, on top of its score. */
const DEFAULT_WEIGHT_FLOOR = 0.05;

/** Why each rejected node was excluded. Surfaced in {@link NoCapacityError} details. */
interface RejectionTally {
  wrongNetwork: number;
  unhealthy: number;
  wrongModel: number;
  notOptedIn: number;
  saturated: number;
  excluded: number;
  unpriceable: number;
}

interface Candidate {
  record: NodeRecord;
  /** Quoted price for the requested model, in atomic USDC units per 1000 tokens. */
  price: bigint;
  score: number;
}

export interface NodeSelectorOptions {
  /**
   * CAIP-2 network the gateway settles on. Nodes registered on any other network are
   * ineligible.
   *
   * Registrations outlive the network they were made on: they are validated at registration
   * time and then persisted, so flipping a gateway from TestNet to MainNet leaves the old
   * registrations in the store, still healthy, still advertising their models. Routing to one
   * takes the client's money and then pays — or fails to pay — an operator address on a chain
   * the gateway no longer settles on.
   *
   * Observed during the MainNet flip: a TestNet node stayed listed as healthy and routable on
   * a gateway that had moved to MainNet. Omitted, this check is skipped and behaviour is
   * unchanged, which keeps the selector usable in tests that do not care about networks.
   */
  network?: string;
  /** Overrides {@link DEFAULT_WEIGHTS}. */
  weights?: ScoreWeights;
  /**
   * Source of randomness for the weighted draw, expected to yield `[0, 1)`.
   *
   * Injectable so tests can pin the sequence and assert an exact distribution; defaults to
   * `Math.random`.
   */
  rng?: () => number;
  /**
   * Minimum draw weight for any eligible candidate, default {@link DEFAULT_WEIGHT_FLOOR}.
   *
   * The worst candidate always normalizes to a score of 0 on at least one dimension, so without
   * a floor it could be starved permanently — and a starved node never accumulates the outcomes
   * that would prove it has recovered. Must be greater than 0.
   */
  weightFloor?: number;
}

export interface SelectOptions {
  /** Nodes to skip, e.g. ones that already failed this request during a retry. */
  excludeNodeIds?: string[];
}

export class NodeSelector {
  readonly #store: NodeStore;
  readonly #weights: ScoreWeights;
  readonly #rng: () => number;
  readonly #weightFloor: number;
  readonly #network: string | undefined;

  constructor(store: NodeStore, options: NodeSelectorOptions = {}) {
    this.#store = store;
    this.#network = options.network;
    this.#weights = options.weights ?? DEFAULT_WEIGHTS;
    this.#rng = options.rng ?? Math.random;
    const floor = options.weightFloor ?? DEFAULT_WEIGHT_FLOOR;
    this.#weightFloor = Number.isFinite(floor) && floor > 0 ? floor : DEFAULT_WEIGHT_FLOOR;
  }

  /**
   * Picks a node for `model`.
   *
   * A node is eligible only if it is healthy, advertises the model, has verified USDC opt-in
   * (an operator that cannot receive the ASA cannot be paid, so routing to it would burn the
   * inbound payment), is below its concurrency cap, and is not excluded.
   *
   * The returned selection does **not** reserve capacity. The caller owns the
   * `beginRequest`/`endRequest` bracket, because only the caller knows when the request it is
   * about to issue actually finishes.
   *
   * @throws {NoCapacityError} when no node qualifies.
   */
  async select(model: string, opts: SelectOptions = {}): Promise<NodeSelection> {
    const excluded = new Set(opts.excludeNodeIds ?? []);
    const records = await this.#store.list();
    const tally: RejectionTally = {
      wrongNetwork: 0,
      unhealthy: 0,
      wrongModel: 0,
      notOptedIn: 0,
      saturated: 0,
      excluded: 0,
      unpriceable: 0,
    };

    const eligible: Array<{ record: NodeRecord; price: bigint }> = [];
    for (const record of records) {
      if (excluded.has(record.registration.nodeId)) {
        tally.excluded += 1;
        continue;
      }
      // Checked before health: a node on the wrong chain is not unhealthy, it is irrelevant,
      // and reporting it as unhealthy would send an operator chasing a node that is fine.
      if (this.#network !== undefined && record.registration.network !== this.#network) {
        tally.wrongNetwork += 1;
        continue;
      }
      if (!record.health.healthy) {
        tally.unhealthy += 1;
        continue;
      }
      // Compared case-insensitively, to match how the price is resolved. Pricing normalizes
      // the model id but this used exact equality, so `LLAMA-3.3-70B-Versatile` was quoted
      // the premium tier and then could never be routed — the client is charged for a
      // capability the selector refuses to find.
      if (
        !record.registration.capabilities.some(
          (c) => normalizeModelId(c.model) === normalizeModelId(model),
        )
      ) {
        tally.wrongModel += 1;
        continue;
      }
      if (!record.usdcOptedIn) {
        tally.notOptedIn += 1;
        continue;
      }
      if (record.health.inFlight >= record.health.maxConcurrency) {
        tally.saturated += 1;
        continue;
      }
      const price = nodePriceAtomic(record, model);
      if (price === null) {
        tally.unpriceable += 1;
        continue;
      }
      eligible.push({ record, price });
    }

    if (eligible.length === 0) {
      throw new NoCapacityError(`no healthy node can serve model "${model}"`, {
        model,
        registeredNodes: records.length,
        rejected: { ...tally },
      });
    }

    // Sorting by nodeId makes the cumulative-weight walk depend only on the candidate set and
    // the rng draw, never on the store's iteration order — so a pinned rng is reproducible.
    eligible.sort((a, b) => (a.record.registration.nodeId < b.record.registration.nodeId ? -1 : 1));

    let minLatencyMs = Number.POSITIVE_INFINITY;
    let maxLatencyMs = Number.NEGATIVE_INFINITY;
    let minPriceAtomic: bigint | null = null;
    let maxPriceAtomic: bigint | null = null;
    for (const { record, price } of eligible) {
      const latency = record.health.latencyMsP95;
      if (latency < minLatencyMs) minLatencyMs = latency;
      if (latency > maxLatencyMs) maxLatencyMs = latency;
      if (minPriceAtomic === null || price < minPriceAtomic) minPriceAtomic = price;
      if (maxPriceAtomic === null || price > maxPriceAtomic) maxPriceAtomic = price;
    }

    const context = {
      model,
      minLatencyMs,
      maxLatencyMs,
      minPriceAtomic: minPriceAtomic ?? 0n,
      maxPriceAtomic: maxPriceAtomic ?? 0n,
      weights: this.#weights,
    };

    const candidates: Candidate[] = eligible.map(({ record, price }) => ({
      record,
      price,
      score: scoreNode(record, context),
    }));

    const chosen = this.#weightedChoice(candidates);
    return {
      node: chosen.record,
      score: chosen.score,
      reason: describeSelection(chosen, candidates.length, model),
    };
  }

  /**
   * Draws one candidate with probability proportional to `score + weightFloor`.
   *
   * @param candidates Non-empty and already sorted deterministically.
   */
  #weightedChoice(candidates: readonly Candidate[]): Candidate {
    const weights = candidates.map(
      (c) => (Number.isFinite(c.score) ? c.score : 0) + this.#weightFloor,
    );
    const total = weights.reduce((sum, w) => sum + w, 0);

    const draw = this.#rng();
    const unit = Number.isFinite(draw) ? Math.min(1, Math.max(0, draw)) : 0;
    let threshold = unit * total;

    for (let i = 0; i < candidates.length; i += 1) {
      threshold -= weights[i] ?? 0;
      if (threshold < 0) {
        const picked = candidates[i];
        if (picked !== undefined) return picked;
      }
    }
    // Reached only when the accumulated rounding error leaves `threshold` at exactly 0 after the
    // final subtraction (i.e. the rng returned 1). The last candidate is the correct answer.
    const last = candidates[candidates.length - 1];
    if (last === undefined) {
      throw new NoCapacityError("weighted selection was called with an empty candidate set");
    }
    return last;
  }
}

/** Operator-readable explanation, surfaced in logs and the debug header. Capped at 512 chars. */
function describeSelection(chosen: Candidate, candidateCount: number, model: string): string {
  const h = chosen.record.health;
  const reason =
    `selected ${chosen.record.registration.nodeId} for "${model}" ` +
    `with score ${chosen.score.toFixed(4)} from ${candidateCount} ` +
    `candidate${candidateCount === 1 ? "" : "s"}: ` +
    `p50 ${Math.round(h.latencyMsP50)}ms, p95 ${Math.round(h.latencyMsP95)}ms, ` +
    `price ${atomicToUsdc(chosen.price)} USDC/1k tokens, ` +
    `quality ${h.qualityScore.toFixed(3)}, uptime ${h.uptimeRatio.toFixed(3)}, ` +
    `load ${h.inFlight}/${h.maxConcurrency}`;
  return reason.length > 512 ? reason.slice(0, 512) : reason;
}

export {
  DEFAULT_WEIGHTS,
  nodePriceAtomic,
  scoreNode,
  type ScoreContext,
  type ScoreWeights,
} from "./score.js";
