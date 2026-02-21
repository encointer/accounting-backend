/**
 * Cycle flow decomposition for directed flow graphs.
 *
 * Repeatedly finds a cycle, peels the bottleneck (min-edge) flow,
 * and accumulates circular flow. The circularity index is the fraction
 * of total edge-flow that participates in cycles.
 */

/**
 * @param {Array<{id: string}>} nodes
 * @param {Array<{source: string, target: string, amount: number}>} edges
 * @returns {number} circularity ratio in [0, 1]
 */
export function computeCircularity(nodes, edges) {
    if (!edges || edges.length === 0) return 0;

    const totalFlow = edges.reduce((sum, e) => sum + e.amount, 0);
    if (totalFlow === 0) return 0;

    // Build residual adjacency: source → Map<target, amount>
    const residual = new Map();
    for (const e of edges) {
        if (!residual.has(e.source)) residual.set(e.source, new Map());
        const out = residual.get(e.source);
        out.set(e.target, (out.get(e.target) || 0) + e.amount);
    }

    let circularFlow = 0;

    // Repeatedly find and peel cycles
    for (;;) {
        const cycle = findCycle(residual);
        if (!cycle) break;

        // Find bottleneck
        let bottleneck = Infinity;
        for (let i = 0; i < cycle.length; i++) {
            const u = cycle[i];
            const v = cycle[(i + 1) % cycle.length];
            bottleneck = Math.min(bottleneck, residual.get(u).get(v));
        }

        // Peel bottleneck flow from each cycle edge
        for (let i = 0; i < cycle.length; i++) {
            const u = cycle[i];
            const v = cycle[(i + 1) % cycle.length];
            const out = residual.get(u);
            const remaining = out.get(v) - bottleneck;
            if (remaining < 1e-9) {
                out.delete(v);
                if (out.size === 0) residual.delete(u);
            } else {
                out.set(v, remaining);
            }
        }

        circularFlow += bottleneck * cycle.length;
    }

    return circularFlow / totalFlow;
}

/**
 * Find any cycle in the residual graph via DFS.
 * Returns array of node IDs forming the cycle, or null.
 */
function findCycle(residual) {
    const visited = new Set();
    const inStack = new Set();
    const parent = new Map();

    for (const start of residual.keys()) {
        if (visited.has(start)) continue;

        const stack = [start];
        const iterators = new Map();
        iterators.set(start, (residual.get(start) || new Map()).keys());
        inStack.add(start);
        visited.add(start);

        while (stack.length > 0) {
            const u = stack[stack.length - 1];
            const iter = iterators.get(u);
            const next = iter.next();

            if (next.done) {
                stack.pop();
                inStack.delete(u);
                continue;
            }

            const v = next.value;
            if (inStack.has(v)) {
                // Found cycle — extract it
                const cycle = [v];
                for (let i = stack.length - 1; i >= 0; i--) {
                    if (stack[i] === v) break;
                    cycle.push(stack[i]);
                }
                cycle.reverse();
                return cycle;
            }

            if (!visited.has(v) && residual.has(v)) {
                visited.add(v);
                inStack.add(v);
                parent.set(v, u);
                stack.push(v);
                iterators.set(v, (residual.get(v) || new Map()).keys());
            }
        }
    }

    return null;
}
