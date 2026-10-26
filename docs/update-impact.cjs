// Rebuild the static impact figures from the reviewed source register.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = __dirname;
const data = JSON.parse(fs.readFileSync(path.join(root, 'assets/nc-restrictions.json'), 'utf8'));
const orgs = data.organizations;
assert.equal(new Set(orgs.map(o => o.id)).size, orgs.length, 'Each organization is counted once');
assert.equal(new Set(orgs.map(o => o.source)).size, orgs.length, 'Each organization has a distinct source');
const enrolled = orgs.filter(o => o.enrollmentFall2025 !== null);
enrolled.forEach(o => { assert.ok(Number.isSafeInteger(o.enrollmentFall2025) && o.enrollmentFall2025 > 0); assert.ok(data.populationSources[o.enrollmentSource]); });
const total = enrolled.reduce((sum, o) => sum + o.enrollmentFall2025, 0);
const { promptsPerUserPerDay, sensitivePromptRate, usageSource, sensitivitySource } = data.scenario;
assert.ok(promptsPerUserPerDay > 0 && sensitivePromptRate > 0 && sensitivePromptRate <= 1);
const dailySensitive = total * promptsPerUserPerDay * sensitivePromptRate;
const estimate = Math.round(dailySensitive);
const annualEstimate = Math.round(dailySensitive * 365);
const fmt = n => n.toLocaleString('en-US');
const escape = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const link = (url, label) => `<a href="${escape(url)}">${escape(label)}</a>`;
const groups = [...new Set(orgs.map(o => o.sector))];
const reviewed = new Date(data.reviewedOn + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
const counts = groups.map(g => `${orgs.filter(o => o.sector === g).length} ${g.toLowerCase()}`).join(' · ');
const overview = `Reviewed ${reviewed}. ${orgs.length} named organizations: ${counts}. ${data.definition} ${data.countingRule}`;
const population = `${fmt(total)} student enrollments across ${enrolled.length} cited universities. ${data.populationScope} The UNC System figures are preliminary; all selected counts refer to fall 2025.`;
const scenario = `If every student represented by the ${fmt(total)} enrollments used ChatGPT with Cloak: ${fmt(total)} × ${promptsPerUserPerDay} prompts/day × ${sensitivePromptRate * 100}% = approximately ${fmt(estimate)} sensitive prompts per day, or ${fmt(annualEstimate)} per year at the same daily rate. ${data.scenario.meaning}`;
const studyNotes = data.scenario.studyNotes;
const details = `<details id="impact-sources" class="impact-sources"><summary>All ${orgs.length} organizations, sources &amp; calculations <span aria-hidden="true">+</span></summary>
<p>${escape(overview)}</p>
${groups.map(g => `<h3>${escape(g)} · ${orgs.filter(o => o.sector === g).length}</h3><ul>${orgs.filter(o => o.sector === g).map(o => `<li>${link(o.source, o.name + ' ↗')}<span>${escape(o.restriction)}</span></li>`).join('\n')}</ul>`).join('\n')}
<h3>Population subtotal · ${enrolled.length} universities</h3>
<p>${escape(population)}</p>
<p>${enrolled.map(o => `${escape(o.name)}: ${link(data.populationSources[o.enrollmentSource], fmt(o.enrollmentFall2025))}`).join(' · ')}.</p>
<h3>If everyone used Cloak</h3><p>${escape(scenario)}</p>
<p>${escape(studyNotes)} ${link(usageSource, 'Epoch AI: prompt frequency ↗')} · ${link(sensitivitySource, 'Harmonic: sensitive prompt study ↗')}</p>
<p>${escape(data.excluded)} ${link(data.additionalEvidence.truistNCLocation, 'Truist confirms its Charlotte headquarters.')} ${link('assets/nc-restrictions.json', 'Download the source register ↗')}</p></details>`;
const stats = `<div class="proof-numbers" aria-label="Documented restrictions, community size, and modeled sensitive message volume">
<div><strong class="rolling-number" data-number="${orgs.length}">${fmt(orgs.length)}</strong><span>NC organizations with AI privacy limits &amp; guidance</span><small><a href="#impact-sources">${orgs.length} named sources · Not a statewide total ↗</a></small></div>
<div><strong class="rolling-number" data-number="${total}">${fmt(total)}</strong><span>Student enrollments at ${enrolled.length} cited universities</span><small><a href="#impact-sources">Fall 2025 · Community size, not people blocked ↗</a></small></div>
<div><strong class="rolling-number" data-number="${estimate}">${fmt(estimate)}</strong><span>Sensitive messages per day in the full-use scenario</span><small><a href="#impact-sources">≈ ${(annualEstimate / 1e6).toFixed(1)} million/year · View assumptions ↗</a></small></div>
</div>`;
const htmlPath = path.join(root, 'index.html');
let html = fs.readFileSync(htmlPath, 'utf8');
assert.match(html, /<details id="impact-sources"[\s\S]*?<\/details>/);
assert.match(html, /<div class="proof-numbers"[\s\S]*?(?=\s*<div class="proof-followthrough")/);
html = html.replace(/<details id="impact-sources"[\s\S]*?<\/details>/, () => details)
  .replace(/<div class="proof-numbers"[\s\S]*?(?=\s*<div class="proof-followthrough")/, () => stats);
html = html.replace(/<div class="proof-followthrough"><p>[\s\S]*?<\/p>/, () => `<div class="proof-followthrough"><p>If every student in this subtotal used ChatGPT with Cloak, that is an estimated <strong>${fmt(estimate)} sensitive prompts a day to protect.</strong> Cloak masks detected identifiers; this models exposure, not verified prevention.</p>`);
fs.writeFileSync(htmlPath, html);
const md = `# North Carolina AI restrictions: source register\n\n[Back to the Cloak README](../README.md#built-in-north-carolina) · [Machine-readable register](assets/nc-restrictions.json)\n\n${overview}\n\n${groups.map(g => `## ${g}\n\n| Organization | Published restriction |\n| --- | --- |\n${orgs.filter(o => o.sector === g).map(o => `| [${o.name}](${o.source}) | ${o.restriction} |`).join('\n')}`).join('\n\n')}\n\n## Population subtotal\n\n${population}\n\n| University | Fall 2025 enrollment | Source |\n| --- | ---: | --- |\n${enrolled.map(o => `| ${o.name} | ${fmt(o.enrollmentFall2025)} | [${o.enrollmentSource === 'duke' ? 'Duke Facts' : 'UNC System preliminary report'}](${data.populationSources[o.enrollmentSource]}) |`).join('\n')}\n| **Total** | **${fmt(total)}** | Sum of the rows above |\n\n## If everyone used Cloak\n\n${scenario}\n\n${studyNotes}\n\nSources: [Epoch AI usage methodology](${usageSource}) · [Harmonic sensitive-data study](${sensitivitySource})\n\n## Scope and exclusions\n\n${data.excluded}\n\n[Truist confirms its Charlotte headquarters.](${data.additionalEvidence.truistNCLocation}) Guidance pages and conditional approvals are included as restrictions; their inclusion does not mean a legally binding or organization-wide ban. No global employee or customer totals are presented as North Carolina populations. Enrollment figures do not represent observed ChatGPT or Cloak users. Full use is assumed only in the labeled scenario.\n\nTo update: review and edit [the source register](assets/nc-restrictions.json), then run \`node docs/update-impact.cjs\`. The generator recalculates the website counters and this document from the same entries.\n`;
fs.writeFileSync(path.join(root, 'impact-methodology.md'), md);
const guidePath = path.join(root, 'README.md');
let guide = fs.readFileSync(guidePath, 'utf8');
guide = guide.replace(/The three counters show .*?The count is not a statewide census/, `The three counters show ${orgs.length} documented NC organizations with AI privacy limits and guidance, ${fmt(total)} fall 2025 student enrollments across ${enrolled.length} cited universities, and ${fmt(estimate)} modeled sensitive messages per day if every student in the enrollment subtotal used ChatGPT with Cloak (approximately ${(annualEstimate / 1e6).toFixed(1)} million/year). This combines ${promptsPerUserPerDay} daily prompts per weekly active user from Epoch AI with Harmonic’s ${sensitivePromptRate * 100}% sensitive-prompt rate; it is an exposure scenario, not measured PII prevention. Recalculate them from the sourced register with \`node docs/update-impact.cjs\`. The count is not a statewide census`);
fs.writeFileSync(guidePath, guide);
console.log(`Updated ${orgs.length} organizations; ${enrolled.length} universities; ${fmt(total)} enrollments; ${fmt(estimate)} modeled sensitive messages/day; ${fmt(annualEstimate)}/year.`);
