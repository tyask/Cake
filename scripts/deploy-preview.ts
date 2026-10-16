// The old direct-deploy entrypoint uses the same serialized main workflow.
import { runPreviewCommand } from './preview-command';
void runPreviewCommand('deploy', process.argv.slice(2)).catch(() => {
  console.error('Cake: Previewを作成できませんでした。対象PRのActionsを確認してください。'); process.exitCode = 1;
});
