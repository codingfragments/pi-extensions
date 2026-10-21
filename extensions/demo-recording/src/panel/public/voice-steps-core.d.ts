export interface VoiceStep {
  key: "approve" | "voice" | "edit" | "annotations";
  title: string;
  detail: string;
  done: boolean;
  state: "done" | "next" | "later";
}
export function voiceSteps(o: {
  approved: boolean;
  voiced: boolean;
  autoSuggest?: boolean;
}): VoiceStep[];
