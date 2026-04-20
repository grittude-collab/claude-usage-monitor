#!/usr/bin/env node
/**
 * 비밀번호를 SHA-256 해시로 변환하여 docs/index.html 에 자동 적용
 * 사용법: node scripts/hash-password.js
 */
const crypto   = require('crypto');
const readline = require('readline');
const fs       = require('fs');
const path     = require('path');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question('비밀번호 입력: ', (password) => {
  rl.close();
  if (!password.trim()) { console.error('비밀번호를 입력하세요'); process.exit(1); }

  const hash    = crypto.createHash('sha256').update(password).digest('hex');
  const htmlPath = path.join(__dirname, '..', 'docs', 'index.html');

  let html = fs.readFileSync(htmlPath, 'utf-8');
  html = html.replace(/passwordHash:\s*'[^']*'/, `passwordHash: '${hash}'`);
  fs.writeFileSync(htmlPath, html);

  console.log(`✅ 비밀번호 해시가 index.html 에 저장되었습니다`);
  console.log(`   ${hash}`);
  console.log(`\n이제 git add docs/index.html && git push 로 배포하세요.`);
});
