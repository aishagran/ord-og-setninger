
/* Edels Verden – longitudinal learning data engine v2
   Raw observations are immutable; adult interpretation is stored separately.
   Formspree policy: at most one consolidated submission per completed session. */
(function(){
  const DB_KEY='edels_verden_learning_db_v2';
  const QUEUE_KEY='edels_verden_formspree_queue_v2';
  const ENDPOINT='https://formspree.io/f/mqeolldg';

  const now=()=>new Date().toISOString();
  const uuid=()=> (crypto.randomUUID ? crypto.randomUUID() :
    'ev-'+Date.now()+'-'+Math.random().toString(16).slice(2));

  function read(key, fallback){
    try { return JSON.parse(localStorage.getItem(key)||JSON.stringify(fallback)); }
    catch(e){ return fallback; }
  }
  function write(key,val){ localStorage.setItem(key,JSON.stringify(val)); }

  function db(){
    const d=read(DB_KEY,{version:2,sessions:[],conceptProfiles:{},updatedAt:null});
    d.version=2; d.sessions ||= []; d.conceptProfiles ||= {};
    return d;
  }
  function saveDB(d){ d.updatedAt=now(); write(DB_KEY,d); }

  function createSession(meta={}){
    const d=db();
    const s={
      sessionId:uuid(), schemaVersion:2, startedAt:now(), completedAt:null,
      status:'in_progress',
      meta:{
        title:meta.title||document.title||'Edels Verden',
        researchGoal:meta.researchGoal||'functional_learning_profile',
        sourcePage:location.pathname.split('/').pop()||'index.html',
        schoolSubject:meta.schoolSubject||null
      },
      trials:[], adultInterpretations:[], events:[],
      submission:{status:'not_sent',submittedAt:null}
    };
    d.sessions.push(s); saveDB(d); return s.sessionId;
  }
  function getSession(id){
    const d=db(); return d.sessions.find(s=>s.sessionId===id)||null;
  }
  function mutateSession(id, fn){
    const d=db(); const s=d.sessions.find(x=>x.sessionId===id);
    if(!s) return null; fn(s); saveDB(d); return s;
  }
  function startTrial(sessionId, meta={}){
    const trialId=uuid();
    mutateSession(sessionId,s=>s.trials.push({
      trialId, createdAt:now(),
      target:meta.target||null,
      researchGoal:meta.researchGoal||null,
      taskType:meta.taskType||null,
      modality:meta.modality||null,
      condition:meta.condition||null,
      question:meta.question||null,
      context:meta.context||null,
      retentionIntervalDays:meta.retentionIntervalDays??null,
      questionShownAt:now(),
      firstResponse:null, firstResponseStartedAt:null, firstResponseSubmittedAt:null,
      supports:[], supportRemovedResponse:null,
      generalization:null, rawEvents:[]
    }));
    return trialId;
  }
  function responseStarted(sessionId,trialId){
    mutateSession(sessionId,s=>{
      const t=s.trials.find(x=>x.trialId===trialId);
      if(t && !t.firstResponseStartedAt) t.firstResponseStartedAt=now();
    });
  }
  function saveFirstResponse(sessionId,trialId,value,extra={}){
    mutateSession(sessionId,s=>{
      const t=s.trials.find(x=>x.trialId===trialId);
      if(!t || t.firstResponse!==null) return; // immutable first response
      t.firstResponse=String(value??'');
      t.firstResponseSubmittedAt=now();
      t.firstResponseMeta={...extra};
    });
  }
  function addSupport(sessionId,trialId,level,type,content,responseAfter=null){
    mutateSession(sessionId,s=>{
      const t=s.trials.find(x=>x.trialId===trialId); if(!t)return;
      t.supports.push({at:now(),level:Number(level),type:type||null,content:content||null,responseAfter});
    });
  }
  function setSupportResponse(sessionId,trialId,index,response){
    mutateSession(sessionId,s=>{
      const t=s.trials.find(x=>x.trialId===trialId); if(!t||!t.supports[index])return;
      if(t.supports[index].responseAfter==null) t.supports[index].responseAfter=String(response??'');
    });
  }
  function saveSupportRemoved(sessionId,trialId,response){
    mutateSession(sessionId,s=>{
      const t=s.trials.find(x=>x.trialId===trialId); if(t && t.supportRemovedResponse===null)
        t.supportRemovedResponse={at:now(),response:String(response??'')};
    });
  }
  function saveGeneralization(sessionId,trialId,context,response){
    mutateSession(sessionId,s=>{
      const t=s.trials.find(x=>x.trialId===trialId); if(t && t.generalization===null)
        t.generalization={at:now(),context:context||null,response:String(response??'')};
    });
  }
  function interpret(sessionId,trialId,analysis={}){
    mutateSession(sessionId,s=>{
      s.adultInterpretations.push({
        interpretationId:uuid(), trialId, at:now(),
        conceptDemonstrated:analysis.conceptDemonstrated||'not_reviewed',
        targetWordRetrieved:analysis.targetWordRetrieved||'not_reviewed',
        responseClassification:analysis.responseClassification||null,
        formulation:analysis.formulation||null,
        grammar:analysis.grammar||null,
        orthography:analysis.orthography||null,
        sequence:analysis.sequence||null,
        causality:analysis.causality||null,
        selfCorrection:analysis.selfCorrection??null,
        notes:analysis.notes||null
      });
    });
  }
  function completeSession(sessionId){
    return mutateSession(sessionId,s=>{
      if(!s.completedAt) s.completedAt=now();
      s.status='completed';
    });
  }

  // Queue + send: one Formspree request per completed session.
  function queueSession(sessionId){
    const s=getSession(sessionId); if(!s || s.status!=='completed') return false;
    const q=read(QUEUE_KEY,[]);
    if(!q.some(x=>x.sessionId===sessionId) && s.submission.status!=='sent'){
      q.push({sessionId,queuedAt:now(),attempts:0}); write(QUEUE_KEY,q);
    }
    return true;
  }
  async function flushQueue(){
    // NB: do NOT bail out on !navigator.onLine — that flag has been seen to
    // report false even with a working connection, which silently skipped
    // the final submission while the manual "send partial" button (which
    // never checks it) kept working. Just attempt the fetch; if truly
    // offline it will fail and stay queued for the next retry.
    let q=read(QUEUE_KEY,[]);
    for(const item of [...q]){
      const s=getSession(item.sessionId);
      if(!s || s.submission.status==='sent'){
        q=q.filter(x=>x.sessionId!==item.sessionId); write(QUEUE_KEY,q); continue;
      }
      try{
        const payload={
          _subject:'Edels Verden – fullført økt',
          session_id:s.sessionId,
          title:s.meta.title,
          completed_at:s.completedAt,
          schema_version:s.schemaVersion,
          data:JSON.stringify(s)
        };
        const r=await fetch(ENDPOINT,{
          method:'POST',
          headers:{'Content-Type':'application/json','Accept':'application/json'},
          body:JSON.stringify(payload),
          keepalive:true // survive the page being closed right after "Ferdig!"
        });
        if(!r.ok) throw new Error('HTTP '+r.status);
        mutateSession(s.sessionId,x=>{x.submission={status:'sent',submittedAt:now()};});
        q=q.filter(x=>x.sessionId!==item.sessionId); write(QUEUE_KEY,q);
      }catch(e){
        item.attempts=(item.attempts||0)+1; item.lastAttemptAt=now();
        write(QUEUE_KEY,q); break;
      }
    }
  }
  function finishAndSubmit(sessionId){
    completeSession(sessionId); queueSession(sessionId); flushQueue();
  }
  function exportAll(){
    const blob=new Blob([JSON.stringify(db(),null,2)],{type:'application/json'});
    const a=document.createElement('a'); a.href=URL.createObjectURL(blob);
    a.download='edels-verden-data-'+new Date().toISOString().slice(0,10)+'.json';
    a.click(); URL.revokeObjectURL(a.href);
  }
  function csvEscape(v){ const x=String(v??''); return '"'+x.replaceAll('"','""')+'"'; }
  function exportCSV(){
    const rows=[['session_id','date','title','target','goal','modality','question','first_response','support_levels','support_removed','generalization']];
    for(const s of db().sessions) for(const t of s.trials){
      rows.push([s.sessionId,s.startedAt,s.meta.title,t.target,t.researchGoal,t.modality,t.question,t.firstResponse,
        t.supports.map(x=>x.level).join('|'),t.supportRemovedResponse?.response||'',t.generalization?.response||'']);
    }
    const blob=new Blob([rows.map(r=>r.map(csvEscape).join(',')).join('\n')],{type:'text/csv;charset=utf-8'});
    const a=document.createElement('a'); a.href=URL.createObjectURL(blob);
    a.download='edels-verden-data-'+new Date().toISOString().slice(0,10)+'.csv'; a.click(); URL.revokeObjectURL(a.href);
  }

  window.EdelsData={createSession,getSession,startTrial,responseStarted,saveFirstResponse,addSupport,
    setSupportResponse,saveSupportRemoved,saveGeneralization,interpret,completeSession,queueSession,
    flushQueue,finishAndSubmit,exportAll,exportCSV,DB_KEY,QUEUE_KEY};
  addEventListener('online',flushQueue);
  setTimeout(flushQueue,1200);
})();
