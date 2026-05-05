/**
 * Runner global — exécute tous les fichiers de test
 * Usage: node tests/run-all.js
 */

import { execSync } from 'child_process';
import { readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const RED   = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW= '\x1b[33m';
const CYAN  = '\x1b[36m';
const BOLD  = '\x1b[1m';
const RESET = '\x1b[0m';

const testFiles = readdirSync(__dirname)
  .filter(f => f.endsWith('.test.js') && f !== 'run-all.js')
  .sort();

console.log(`\n${BOLD}${CYAN}╔══════════════════════════════════════════╗`);
console.log(`║     SATOSHI CASINO 21 — TEST SUITE      ║`);
console.log(`╚══════════════════════════════════════════╝${RESET}`);
console.log(`${YELLOW}Exécution de ${testFiles.length} fichiers de tests...${RESET}\n`);

let totalPassed = 0;
let totalFailed = 0;
const results = [];
const startTime = Date.now();

for (const file of testFiles) {
  const filePath = join(__dirname, file);
  const fileStart = Date.now();
  
  try {
    const output = execSync(`node "${filePath}"`, {
      encoding: 'utf8',
      timeout: 15000
    });
    
    // Parser le résumé final
    const lines = output.trim().split('\n');
    const summary = lines[lines.length - 1];
    const match = summary.match(/(\d+) tests, (\d+) passed, (\d+) failed/);
    
    const passed = match ? parseInt(match[2]) : 0;
    const failed = match ? parseInt(match[3]) : 0;
    const duration = Date.now() - fileStart;
    
    totalPassed += passed;
    totalFailed += failed;
    
    const status = failed === 0 ? `${GREEN}✅ PASS${RESET}` : `${RED}❌ FAIL${RESET}`;
    const badge = failed === 0 ? GREEN : RED;
    console.log(`${status} ${BOLD}${file}${RESET}${badge} (${passed}/${passed+failed}) ${duration}ms${RESET}`);
    
    if (failed > 0) {
      // Afficher les lignes d'échec
      lines.filter(l => l.includes('✗')).forEach(l => {
        console.log(`     ${RED}${l.trim()}${RESET}`);
      });
    }
    
    results.push({ file, passed, failed, duration, success: failed === 0 });
    
  } catch (err) {
    const duration = Date.now() - fileStart;
    totalFailed += 1;
    
    console.log(`${RED}❌ ERROR${RESET} ${BOLD}${file}${RESET} ${RED}(crash)${RESET}`);
    
    // Extraire les lignes utiles du stderr/stdout
    const output = (err.stdout || '') + (err.stderr || '');
    const errorLines = output.split('\n')
      .filter(l => l.includes('✗') || l.includes('Error') || l.includes('error'))
      .slice(0, 5);
    
    errorLines.forEach(l => console.log(`     ${RED}${l.trim()}${RESET}`));
    results.push({ file, passed: 0, failed: 1, duration, success: false, crashed: true });
  }
}

const totalDuration = Date.now() - startTime;
const allPassed = totalFailed === 0;

console.log(`\n${BOLD}${CYAN}${'═'.repeat(44)}${RESET}`);
console.log(`${BOLD}RÉSULTATS GLOBAUX${RESET}`);
console.log(`${'─'.repeat(44)}`);
console.log(`  Fichiers  : ${testFiles.length} (${results.filter(r => r.success).length} OK, ${results.filter(r => !r.success).length} KO)`);
console.log(`  Tests     : ${GREEN}${totalPassed} passés${RESET} / ${RED}${totalFailed} échoués${RESET} / ${totalPassed + totalFailed} total`);
console.log(`  Durée     : ${totalDuration}ms`);
console.log(`${'─'.repeat(44)}`);

if (allPassed) {
  console.log(`\n  ${GREEN}${BOLD}✅  TOUS LES TESTS PASSENT${RESET}`);
  console.log(`  ${GREEN}Le casino est prêt pour la production.${RESET}\n`);
} else {
  console.log(`\n  ${RED}${BOLD}❌  ${totalFailed} TEST(S) EN ÉCHEC${RESET}`);
  console.log(`  ${RED}Corrigez les problèmes avant de déployer.${RESET}\n`);
}

process.exit(allPassed ? 0 : 1);
