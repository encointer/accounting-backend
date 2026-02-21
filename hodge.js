/**
 * Helmholtz-Hodge Decomposition for directed flow graphs.
 *
 * Decomposes edge flows f into gradient (source→sink) and circular components.
 * circularity = ||f_circular||₁ / ||f||₁
 */

/**
 * @param {Array<{id: string}>} nodes
 * @param {Array<{source: string, target: string, amount: number}>} edges
 * @returns {number} circularity ratio in [0, 1]
 */
export function computeCircularity(nodes, edges) {
    if (!edges || edges.length === 0) return 0;

    // Assign integer indices to nodes
    const nodeIndex = new Map();
    nodes.forEach((n, i) => nodeIndex.set(n.id, i));
    const n = nodes.length;

    // Build Laplacian L (n×n) and divergence vector div (n)
    // div(v) = sum(incoming flow) - sum(outgoing flow)
    const L = Array.from({ length: n }, () => new Float64Array(n));
    const div = new Float64Array(n);

    for (const edge of edges) {
        const u = nodeIndex.get(edge.source);
        const v = nodeIndex.get(edge.target);
        if (u === undefined || v === undefined) continue;
        const f = edge.amount;

        // Divergence: positive for sinks, negative for sources
        div[v] += f;
        div[u] -= f;

        // Laplacian: L = B·Bᵀ where B is incidence matrix
        // For each edge (u,v): L[u][u]+=1, L[v][v]+=1, L[u][v]-=1, L[v][u]-=1
        L[u][u] += 1;
        L[v][v] += 1;
        L[u][v] -= 1;
        L[v][u] -= 1;
    }

    // Solve L·s = div with node 0 pinned to s=0 (Gaussian elimination)
    // Remove row/col 0 → solve (n-1)×(n-1) system
    const m = n - 1;
    if (m === 0) return 0;

    // Build augmented matrix [A | b] where A = L[1:,1:], b = div[1:]
    const aug = Array.from({ length: m }, (_, i) => {
        const row = new Float64Array(m + 1);
        for (let j = 0; j < m; j++) {
            row[j] = L[i + 1][j + 1];
        }
        row[m] = div[i + 1];
        return row;
    });

    // Gaussian elimination with partial pivoting
    for (let col = 0; col < m; col++) {
        // Find pivot
        let maxVal = Math.abs(aug[col][col]);
        let maxRow = col;
        for (let row = col + 1; row < m; row++) {
            const val = Math.abs(aug[row][col]);
            if (val > maxVal) { maxVal = val; maxRow = row; }
        }
        if (maxVal < 1e-12) continue; // singular column
        if (maxRow !== col) {
            const tmp = aug[col]; aug[col] = aug[maxRow]; aug[maxRow] = tmp;
        }
        const pivot = aug[col][col];
        for (let row = col + 1; row < m; row++) {
            const factor = aug[row][col] / pivot;
            for (let j = col; j <= m; j++) {
                aug[row][j] -= factor * aug[col][j];
            }
        }
    }

    // Back substitution
    const s = new Float64Array(n); // s[0] = 0 (pinned)
    for (let i = m - 1; i >= 0; i--) {
        if (Math.abs(aug[i][i]) < 1e-12) { s[i + 1] = 0; continue; }
        let sum = aug[i][m];
        for (let j = i + 1; j < m; j++) {
            sum -= aug[i][j] * s[j + 1];
        }
        s[i + 1] = sum / aug[i][i];
    }

    // Compute circularity: Σ|f_circular| / Σ|f|
    let totalFlow = 0;
    let circularFlow = 0;
    for (const edge of edges) {
        const u = nodeIndex.get(edge.source);
        const v = nodeIndex.get(edge.target);
        if (u === undefined || v === undefined) continue;
        const f = edge.amount;
        const fGradient = s[v] - s[u];
        const fCircular = f - fGradient;
        totalFlow += Math.abs(f);
        circularFlow += Math.abs(fCircular);
    }

    if (totalFlow === 0) return 0;
    return Math.min(circularFlow / totalFlow, 1);
}
