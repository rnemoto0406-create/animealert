function normalize(str) {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function editDistance(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function similarity(a, b) {
  const na = normalize(a), nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const longer = na.length >= nb.length ? na : nb;
  const shorter = na.length < nb.length ? na : nb;
  return (longer.length - editDistance(longer, shorter)) / longer.length;
}

function mergeProducts(allProducts) {
  const merged = [];
  const used = new Set();

  for (let i = 0; i < allProducts.length; i++) {
    if (used.has(i)) continue;
    const primary = { ...allProducts[i] };
    primary.sources = [primary.source];

    for (let j = i + 1; j < allProducts.length; j++) {
      if (used.has(j)) continue;
      if (similarity(allProducts[i].name, allProducts[j].name) > 0.85) {
        if (!primary.sources.includes(allProducts[j].source)) {
          primary.sources.push(allProducts[j].source);
        }
        used.add(j);
      }
    }

    merged.push(primary);
    used.add(i);
  }

  return merged;
}

module.exports = { mergeProducts };
