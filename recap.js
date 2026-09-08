// recap.js -- shared sparkline + trajectory helpers for the Cattlemen's Weekly recap
// block on both team.html (own team) and admin.html (projector, all teams). No
// libraries: plain inline SVG. Never hand these values from secret objective scoring --
// only public KPIs (cash, herd, $Beef, exploited%, rank) ever plot here.
'use strict';
window.Recap = (function () {
  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Minimal inline SVG sparkline. values: number[]. Returns an <svg> string.
  function sparkline(values, opts) {
    opts = opts || {};
    const w = opts.w || 84, h = opts.h || 20, color = opts.color || '#c8a96e', pad = 2;
    if (!values || values.length < 2) return `<svg width="${w}" height="${h}" style="vertical-align:middle"></svg>`;
    const min = Math.min(...values), max = Math.max(...values);
    const range = (max - min) || 1;
    const stepX = (w - pad * 2) / (values.length - 1);
    const pts = values.map((v, i) => {
      const x = pad + i * stepX;
      const y = h - pad - ((v - min) / range) * (h - pad * 2);
      return x.toFixed(1) + ',' + y.toFixed(1);
    });
    const last = pts[pts.length - 1].split(',');
    return `<svg width="${w}" height="${h}" style="vertical-align:middle" viewBox="0 0 ${w} ${h}">` +
      `<polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>` +
      `<circle cx="${last[0]}" cy="${last[1]}" r="1.8" fill="${color}"/></svg>`;
  }

  // history: this team's own yearHistory array [{year,cash,herd,beef,exploited,rank}], or
  // null/undefined when there is no single "own" team (the admin projector view).
  // allTeams: [{name, isMe, history}] -- one entry per outfit, history = its yearHistory.
  // Only the cash trend (the same public score Standings/Leaderboard already show) plots
  // per rival; secret objective weights never enter this file.
  function trajectoryBlock(history, allTeams) {
    const hasOwn = !!(history && history.length >= 2);
    const rivals = (allTeams || []).filter(t => t.history && t.history.length >= 2);
    if (!hasOwn && !rivals.length) return '';

    let ownRows = '';
    if (hasOwn) {
      const metrics = [
        { name: 'Cash',      color: '#4a7fa5', vals: history.map(h => h.cash),
          disp: v => '$' + Math.round(v).toLocaleString() },
        { name: 'Herd',      color: '#6b7c5c', vals: history.map(h => h.herd),
          disp: v => Math.round(v).toLocaleString() + ' hd' },
        { name: '$Beef',     color: '#c8a96e', vals: history.map(h => h.beef),
          disp: v => Math.round(v) },
        { name: 'Exploited', color: '#9b3a1a', vals: history.map(h => h.exploited),
          disp: v => Math.round(v) + '%' },
        { name: 'Rank',      color: '#5b21b6', vals: history.map(h => -h.rank), // lower rank = better, invert so "up" reads as improving
          disp: () => '#' + history[history.length - 1].rank },
      ];
      ownRows = metrics.map(m => {
        const lastDisp = m.disp(m.name === 'Rank' ? null : m.vals[m.vals.length - 1]);
        return `<div style="display:flex;align-items:center;gap:0.5rem;font-size:0.78rem;margin-bottom:0.22rem">` +
          `<span style="width:66px;flex-shrink:0;color:var(--dim,#6b5e4a)">${m.name}</span>` +
          sparkline(m.vals, { color: m.color }) +
          `<span style="font-family:var(--mono,monospace);color:var(--dim,#6b5e4a)">${lastDisp}</span></div>`;
      }).join('');
    }

    let rivalTable = '';
    if (rivals.length) {
      const rows = rivals.map(t => {
        const cashVals = t.history.map(h => h.cash);
        const last = cashVals[cashVals.length - 1];
        return `<tr${t.isMe ? ' style="background:#2f2513"' : ''}><td>${esc(t.name)}${t.isMe ? ' (you)' : ''}</td>` +
          `<td>${sparkline(cashVals, { color: t.isMe ? '#c8a96e' : '#4a7fa5' })}</td>` +
          `<td style="font-family:var(--mono,monospace)">$${Math.round(last).toLocaleString()}</td></tr>`;
      }).join('');
      rivalTable = `<table style="width:100%;font-size:0.78rem;margin-top:${hasOwn ? '0.55rem' : '0'}">` +
        `<thead><tr><th>Outfit</th><th>Cash trend</th><th>Cash</th></tr></thead><tbody>${rows}</tbody></table>`;
    }

    return `<div style="border-top:1px solid var(--border,#d4b896);margin-top:0.7rem;padding-top:0.6rem">` +
      `<div style="font-family:var(--mono,monospace);font-size:0.68rem;letter-spacing:0.08em;text-transform:uppercase;color:var(--dim,#6b5e4a);margin-bottom:0.4rem">Trajectory</div>` +
      ownRows + rivalTable + `</div>`;
  }

  return { esc, sparkline, trajectoryBlock };
})();
