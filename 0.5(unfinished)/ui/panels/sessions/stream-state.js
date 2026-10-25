// Revisioned projection of the selected session. Snapshots are authoritative;
// missing/coalesced revisions request one recovery read instead of guessing.
export function applySessionDelta(data,event){
  if(!data||data.id!==event?.id||data.status!=='running')return 'ignored';
  const {step,delta}=event;if(!step||!delta||step.messageIndex!==(data.messages||[]).length)return 'ignored';
  const current=data.activeStep;
  if(current&&(Number(current.startedAt)>Number(step.startedAt)||current.startedAt===step.startedAt&&Number(current.streamAttempt)>Number(step.streamAttempt)))return 'ignored';
  if(current?.streamId===step.streamId&&Number(current.revision)>=delta.revision)return 'ignored';
  if(delta.reset){data.activeStep={...step,content:delta.content||'',reasoning:delta.reasoning||''};return 'applied';}
  if(current?.streamId!==step.streamId||Number(current.revision)!==delta.fromRevision)return 'gap';
  data.activeStep={...step,content:(current.content||'')+(delta.content||''),reasoning:(current.reasoning||'')+(delta.reasoning||'')};return 'applied';
}
