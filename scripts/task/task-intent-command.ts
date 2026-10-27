import { runTaskIntent } from './task-intent';

void runTaskIntent({ args: process.argv.slice(2) }).catch(error => {
  const code = error instanceof Error && /^CAKE_INTENT_[A-Z_]+$/.test(error.message) ? error.message : 'CAKE_INTENT_FAILED';
  console.error(`Cake: ${code}。引数・計画・承認・凍結状態を確認してください。入力本文・秘密値は表示しません。`);
  process.exitCode = 1;
});
