import { labPromptSnapshot, type LabPromptSettings } from '@pcu/contracts';

export function downloadPrompts(prompts: LabPromptSettings, runId?: string) {
  const url = URL.createObjectURL(new Blob([labPromptSnapshot(prompts) + '\n'], { type: 'application/json;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `nickname-prompts${runId ? '-' + runId : ''}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
