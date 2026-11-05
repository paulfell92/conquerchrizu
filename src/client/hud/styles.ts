/**
 * All HUD/menu CSS in one place, injected at startup (keeps index.html minimal
 * and the single-file build self-contained). System fonts only.
 *
 * Look: walnut-ink panels with a brass hairline, parchment text, heraldic blue
 * vs red. Storybook serif for titles/headings, system sans for numbers.
 */
export const CSS = `
:root{
  --ink: rgba(30,25,20,.9);
  --ink-solid:#1e1914;
  --ink-2: rgba(48,40,31,.92);
  --ink-3:#3a3026;
  --brass:#d9b25a;
  --brass-dim:rgba(217,178,90,.45);
  --parch:#f3e8cc;
  --parch-dim:#c9bb9a;
  --muted:#9d8f73;
  --blue:#3d7be0; --blue-l:#8fb6f5;
  --red:#d9483b; --red-l:#f19a8f;
  --good:#7fd36b; --warn:#e8c25a; --bad:#e3643f;
  --food:#e8b04a; --wood:#b9824c; --gold:#f2d15b;
  --serif:"Iowan Old Style","Palatino Linotype",Palatino,"Book Antiqua","URW Palladio L",Georgia,serif;
  --sans:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --sat:env(safe-area-inset-top,0px); --sar:env(safe-area-inset-right,0px);
  --sab:env(safe-area-inset-bottom,0px); --sal:env(safe-area-inset-left,0px);
  --gap:8px; --tb:46px; --mmw:168px; --mmh:106px; --cw:244px;
}
@media (max-height:430px){ :root{ --tb:42px; --mmw:150px; --mmh:95px; --cw:232px; } }
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;height:100%;overflow:hidden;background:#1f2a18;color:var(--parch);
  font-family:var(--sans);overscroll-behavior:none;touch-action:none;
  -webkit-user-select:none;user-select:none;-webkit-touch-callout:none;-webkit-text-size-adjust:100%}
#app{position:fixed;inset:0;overflow:hidden}
canvas#world{position:absolute;left:0;top:0;display:block;touch-action:none}
button{font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer;touch-action:manipulation}
button:focus-visible{outline:2px solid var(--brass);outline-offset:2px}
.ic{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;flex:none}
.hidden{display:none!important}

/* ---------------------------------------------------------------- panels */
.panel{background:var(--ink);border:1px solid var(--brass-dim);border-radius:10px;
  box-shadow:0 2px 0 rgba(0,0,0,.35),inset 0 1px 0 rgba(255,236,190,.07);
}
#hud{position:absolute;inset:0;pointer-events:none;
  padding:calc(var(--sat) + 6px) calc(var(--sar) + 8px) calc(var(--sab) + 6px) calc(var(--sal) + 8px)}
#hud > *{pointer-events:auto}

@media (min-width:1200px) and (min-height:760px){ #hud{zoom:1.2} }
/* ---------------------------------------------------------------- top bar */
#topbar{position:absolute;left:calc(var(--sal) + 8px);right:calc(var(--sar) + 8px);top:calc(var(--sat) + 6px);
  height:var(--tb);display:flex;align-items:center;gap:6px;pointer-events:none}
#topbar > *{pointer-events:auto}
.res{display:flex;align-items:center;height:100%;padding:0 4px 0 6px}
.res .r{display:flex;align-items:center;gap:4px;padding:0 7px;font-variant-numeric:tabular-nums;font-weight:650;font-size:15px;min-width:58px}
.res .r .ic{width:18px;height:18px}
.res .r.food .ic{color:var(--food)} .res .r.wood .ic{color:var(--wood)} .res .r.gold .ic{color:var(--gold)}
.res .r.pop .ic{color:var(--parch-dim)}
.res .r.full{color:var(--bad)}
.res .sep{width:1px;height:22px;background:var(--brass-dim);margin:0 2px}
.vp{flex:1;min-width:150px;max-width:420px;margin:0 auto;height:100%;display:flex;align-items:center;gap:8px;padding:0 10px}
.vp .side{flex:1;display:flex;flex-direction:column;gap:3px;min-width:0}
.vp .lbl{display:flex;justify-content:space-between;font-size:11px;line-height:1;color:var(--parch-dim);font-variant-numeric:tabular-nums;white-space:nowrap}
.vp .lbl b{color:var(--parch);font-weight:700;font-size:12px}
.vp .bar{height:7px;border-radius:4px;background:rgba(0,0,0,.45);overflow:hidden;position:relative}
.vp .bar i{position:absolute;top:0;bottom:0;border-radius:4px}
.vp .me .bar i{right:0;background:linear-gradient(90deg,#2f63b8,var(--blue-l))}
.vp .cpu .bar i{left:0;background:linear-gradient(270deg,#a8322a,var(--red-l))}
.vp .me .lbl{flex-direction:row-reverse}
.vp .pts{font-size:10.5px;color:var(--muted)}
.vp .clock{font-family:var(--serif);font-size:17px;font-weight:700;color:var(--parch);font-variant-numeric:tabular-nums;
  text-align:center;min-width:52px;line-height:1}
.vp .clock small{display:block;font-family:var(--sans);font-size:10px;font-weight:600;color:var(--brass);margin-top:3px;white-space:nowrap}
.tb-btns{display:flex;gap:6px;height:100%}
.tbtn{height:100%;min-width:44px;padding:0 10px;display:flex;align-items:center;justify-content:center;gap:5px;font-weight:700;font-size:14px}
.tbtn:active{background:var(--ink-3)}
.tbtn.on{color:var(--brass)}

/* ---------------------------------------------------------------- minimap + tools */
#mmwrap{position:absolute;left:calc(var(--sal) + 8px);bottom:calc(var(--sab) + 6px);width:var(--mmw);display:flex;flex-direction:column;gap:6px}
#tools{display:flex;gap:6px}
#tools button{flex:1;height:44px;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:1px;font-size:10px;font-weight:650;color:var(--parch-dim)}
#tools button .ic{width:19px;height:19px;color:var(--parch)}
#tools button.on{background:rgba(217,178,90,.25);border-color:var(--brass);color:var(--parch)}
#tools button.on .ic{color:var(--brass)}
#minimap{width:var(--mmw);height:var(--mmh);display:block;border-radius:8px;border:1px solid var(--brass-dim);
  box-shadow:0 2px 0 rgba(0,0,0,.35);background:#2a331d;touch-action:none}

/* ---------------------------------------------------------------- squad cards */
#cards{position:absolute;bottom:calc(var(--sab) + 6px);left:calc(var(--sal) + 8px + var(--mmw) + 8px);
  right:calc(var(--sar) + 8px);height:62px;display:flex;gap:6px;overflow-x:auto;overflow-y:hidden;
  scrollbar-width:none;pointer-events:auto;align-items:flex-end;touch-action:pan-x}
#cards::-webkit-scrollbar{display:none}
body.ctx-open #cards{right:calc(var(--sar) + 8px + var(--cw) + 8px)}
.card{position:relative;flex:none;width:52px;height:60px;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;
  padding-top:6px;border-radius:9px}
.card .ic{width:24px;height:24px;color:var(--parch)}
.card .n{font-size:12px;font-weight:700;margin-top:1px;font-variant-numeric:tabular-nums}
.card .hk{position:absolute;left:4px;top:2px;font-size:9.5px;color:var(--muted);font-weight:700}
.card .st{position:absolute;right:4px;top:3px;width:7px;height:7px;border-radius:50%}
.card .st.fight{background:var(--bad);box-shadow:0 0 0 2px rgba(227,100,63,.3)}
.card .st.move{background:var(--blue-l)}
.card .hp{position:absolute;left:6px;right:6px;bottom:5px;height:4px;border-radius:2px;background:rgba(0,0,0,.5);overflow:hidden}
.card .hp i{display:block;height:100%;background:var(--good)}
.card.sel{border-color:var(--brass);background:rgba(68,56,32,.92);box-shadow:0 0 0 1px var(--brass),0 2px 0 rgba(0,0,0,.35)}
.card.sel .ic{color:#ffe7a8}
.cards-empty{align-self:center;font-size:12px;color:var(--parch-dim);padding:8px 12px}

/* ---------------------------------------------------------------- context panel */
#ctx{position:absolute;right:calc(var(--sar) + 8px);top:calc(var(--sat) + 6px + var(--tb) + 6px);
  bottom:calc(var(--sab) + 6px);width:var(--cw);display:flex;flex-direction:column;overflow:hidden}
#ctx .head{display:flex;align-items:center;gap:8px;padding:8px 6px 6px 10px;border-bottom:1px solid rgba(217,178,90,.22)}
#ctx .head .badge{width:34px;height:34px;border-radius:8px;display:flex;align-items:center;justify-content:center;flex:none}
#ctx .head .badge .ic{width:22px;height:22px;color:#fff}
#ctx .head .t{flex:1;min-width:0}
#ctx .head h3{margin:0;font-family:var(--serif);font-size:16px;line-height:1.15;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#ctx .head p{margin:2px 0 0;font-size:11px;color:var(--parch-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#ctx .x{width:40px;height:40px;display:flex;align-items:center;justify-content:center;color:var(--parch-dim);border-radius:8px;flex:none}
#ctx .x:active{background:var(--ink-3)}
#ctx .body{flex:1;overflow-y:auto;overflow-x:hidden;padding:8px 8px 10px;display:flex;flex-direction:column;gap:8px;touch-action:pan-y;scrollbar-width:thin}
#ctx .hpline{height:6px;border-radius:3px;background:rgba(0,0,0,.45);overflow:hidden}
#ctx .hpline i{display:block;height:100%;background:var(--good)}
#ctx .note{font-size:11.5px;line-height:1.35;color:var(--parch-dim)}
#ctx h4{margin:2px 2px 0;font-size:11.5px;font-weight:700;color:var(--brass)}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.act{position:relative;min-height:50px;border-radius:8px;background:var(--ink-2);border:1px solid rgba(217,178,90,.28);
  display:flex;flex-direction:column;align-items:flex-start;justify-content:center;gap:2px;padding:6px 7px 5px;text-align:left;overflow:hidden}
.act:active{background:var(--ink-3)}
.act .row{display:flex;align-items:center;gap:6px;width:100%}
.act .row .ic{width:18px;height:18px;color:var(--parch)}
.act .nm{font-size:12.5px;font-weight:700;line-height:1.1;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;hyphens:auto;-webkit-hyphens:auto;word-break:break-word}
.act .cost{display:flex;gap:6px;font-size:11px;font-weight:650;font-variant-numeric:tabular-nums;color:var(--parch-dim)}
.act .cost span{display:flex;align-items:center;gap:2px}
.act .cost .ic{width:12px;height:12px}
.act .cost .food .ic{color:var(--food)} .act .cost .wood .ic{color:var(--wood)} .act .cost .gold .ic{color:var(--gold)}
.act .cost .lack{color:var(--bad)}
.act .why{font-size:10.5px;color:#ff9b7d;line-height:1.15;width:100%}
.act.off{opacity:.62;border-color:rgba(160,140,110,.2)}
.act.off .row .ic{color:var(--muted)}
.act.wide{grid-column:1 / -1;flex-direction:row;justify-content:flex-start;gap:8px;min-height:44px;align-items:center}
.act.wide .ic{width:19px;height:19px}
.act.hot{border-color:var(--brass);background:rgba(90,70,32,.8)}
.queue{display:flex;gap:5px;flex-wrap:wrap}
.qi{position:relative;width:40px;height:40px;border-radius:7px;background:var(--ink-2);border:1px solid rgba(217,178,90,.28);display:flex;align-items:center;justify-content:center}
.qi .ic{width:20px;height:20px}
.qi .p{position:absolute;left:3px;right:3px;bottom:3px;height:3px;background:rgba(0,0,0,.5);border-radius:2px;overflow:hidden}
.qi .p i{display:block;height:100%;background:var(--warn)}
.qi.cancel{border-color:rgba(227,100,63,.6)}
.qi.cancel{color:#ffb39e;background:rgba(227,100,63,.14)}
.stats{display:grid;grid-template-columns:auto 1fr;gap:3px 10px;font-size:12px;color:var(--parch-dim)}
.stats b{color:var(--parch);font-weight:650;font-variant-numeric:tabular-nums}

/* ---------------------------------------------------------------- toasts */
#toasts{position:absolute;left:50%;transform:translateX(-50%);top:calc(var(--sat) + 6px + var(--tb) + 8px);
  display:flex;flex-direction:column;align-items:center;gap:6px;pointer-events:none;width:min(420px,60vw)}
.toast{pointer-events:auto;display:flex;align-items:center;gap:8px;padding:6px 6px 6px 10px;min-height:40px;border-radius:10px;
  font-size:13px;font-weight:600;max-width:100%;animation:tin .18s ease-out}
.toast .ic{width:18px;height:18px}
.toast.warn{border-color:rgba(227,100,63,.75)} .toast.warn .ic{color:var(--bad)}
.toast.good{border-color:rgba(127,211,107,.6)} .toast.good .ic{color:var(--good)}
.toast.info .ic{color:var(--brass)}
.toast .go{margin-left:4px;min-height:34px;padding:0 10px;border-radius:7px;background:rgba(227,100,63,.25);border:1px solid rgba(227,100,63,.7);font-size:12px;font-weight:700}
.toast.out{opacity:0;transition:opacity .3s}
@keyframes tin{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.toast{animation:none}}

/* ---------------------------------------------------------------- peace + command hint */
#peace{position:absolute;left:50%;transform:translateX(-50%);top:calc(var(--sat) + 6px + var(--tb) + 5px);
  display:flex;align-items:center;gap:6px;padding:4px 10px 4px 8px;border-radius:999px;font-size:12px;font-weight:700;
  color:#cfe6c4;border-color:rgba(127,211,107,.55);font-variant-numeric:tabular-nums;pointer-events:none}
#peace .ic{width:15px;height:15px;color:var(--good)}
body.has-peace #toasts{top:calc(var(--sat) + 6px + var(--tb) + 38px)}
#cmdhint{position:absolute;left:calc(var(--sal) + 8px + var(--mmw) + 8px);bottom:calc(var(--sab) + 6px + 62px + 6px);
  display:flex;align-items:center;gap:6px;padding:5px 10px 5px 8px;border-radius:999px;font-size:12px;font-weight:700;
  background:rgba(217,178,90,.92);color:#2a1d0c;pointer-events:none;box-shadow:0 2px 0 rgba(0,0,0,.35)}
#cmdhint .ic{width:15px;height:15px}
/* ---------------------------------------------------------------- mode hint */
#modehint{position:absolute;left:50%;transform:translateX(-50%);bottom:calc(var(--sab) + 76px);padding:8px 8px 8px 12px;border-radius:10px;
  display:flex;align-items:center;gap:10px;font-size:13px;font-weight:650}
#modehint button{min-height:34px;padding:0 10px;border-radius:7px;border:1px solid var(--brass-dim);font-size:12px}

/* ---------------------------------------------------------------- tutorial */
#tut{position:absolute;left:calc(var(--sal) + 8px);right:calc(var(--sar) + 8px);margin:0 auto;top:calc(var(--sat) + 6px + var(--tb) + 6px);
  max-width:520px;display:flex;align-items:flex-start;gap:10px;padding:8px 8px 8px 10px;
  border-color:var(--brass);z-index:5}
body.ctx-open #tut{right:calc(var(--sar) + 8px + var(--cw) + 8px);margin:0}
#tut .tstep{flex:none;min-width:34px;height:24px;border-radius:999px;background:var(--brass);color:#2a1d0c;font-size:12px;font-weight:800;
  display:flex;align-items:center;justify-content:center;font-variant-numeric:tabular-nums;margin-top:1px}
#tut .tbody{flex:1;min-width:0}
#tut h3{margin:0;font-family:var(--serif);font-size:15px;line-height:1.2}
#tut p{margin:2px 0 0;font-size:12px;line-height:1.35;color:var(--parch-dim)}
#tut .tbtns{display:flex;flex-direction:column;gap:5px;flex:none}
#tut .btn.small{min-height:36px;padding:0 10px;font-size:12px}
#tutring.box{border-radius:12px}
#tutring{position:absolute;left:0;top:0;display:none;border-radius:50%;
  transform-origin:center;pointer-events:none;z-index:4;
  border:3px solid #ffe08a;box-shadow:0 0 0 3px rgba(42,29,12,.55),0 0 18px rgba(255,224,138,.6);animation:tpulse 1.1s ease-in-out infinite}
@keyframes tpulse{0%,100%{opacity:1;scale:1}50%{opacity:.55;scale:1.12}}
@media (prefers-reduced-motion:reduce){#tutring{animation:none}}
body:has(#tut) #toasts{top:calc(var(--sat) + 6px + var(--tb) + 86px)}
body:has(#tut) #peace{display:none}
body:has(#tut) #cmdhint{display:none}
/* ---------------------------------------------------------------- overlays */
.overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:auto;
  padding:calc(var(--sat) + 12px) calc(var(--sar) + 16px) calc(var(--sab) + 12px) calc(var(--sal) + 16px)}
.overlay.dim{background:rgba(16,13,10,.55)}
.btn{min-height:46px;padding:0 20px;border-radius:10px;font-weight:700;font-size:15px;background:var(--ink-2);border:1px solid var(--brass-dim);display:inline-flex;align-items:center;justify-content:center;gap:8px}
.btn:active{background:var(--ink-3)}
.btn.primary{background:linear-gradient(#e2bd63,#c7983c);color:#2a1d0c;border-color:#f1d68e;box-shadow:0 3px 0 #7a5a1e}
.btn.primary:active{transform:translateY(2px);box-shadow:0 1px 0 #7a5a1e}
.btn.danger{border-color:rgba(227,100,63,.6);color:#ffc6b5}

/* start menu */
#menu{background:linear-gradient(90deg,rgba(18,14,9,.78) 0%,rgba(18,14,9,.45) 45%,rgba(18,14,9,.6) 100%)}
.menu{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);gap:28px;align-items:center;width:min(880px,100%);max-height:100%}
.title{display:flex;flex-direction:column;align-items:flex-start;gap:10px}
.crest{display:flex;align-items:center;gap:12px}
.shield{width:58px;height:68px;flex:none}
.title h1{margin:0;font-family:var(--serif);font-weight:700;font-size:clamp(40px,7.4vw,76px);line-height:.92;letter-spacing:-.01em;color:#fbf1d6;
  text-shadow:0 3px 0 #3a2a14,0 6px 18px rgba(0,0,0,.55)}
.title h1 span{display:block;font-size:.52em;letter-spacing:.02em;color:var(--brass);text-shadow:0 2px 0 #3a2a14}
.title .lede{margin:2px 0 0;font-family:var(--serif);font-size:15.5px;line-height:1.45;color:#efe3c4;max-width:40ch;text-shadow:0 1px 2px rgba(0,0,0,.8)}
.menu .box{padding:16px;display:flex;flex-direction:column;gap:12px}
.menu .box h2{margin:0;font-family:var(--serif);font-size:17px;font-weight:700}
.seg{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;padding:4px;background:rgba(0,0,0,.35);border-radius:10px}
.seg button{min-height:44px;border-radius:7px;font-weight:700;font-size:14px;color:var(--parch-dim)}
.seg button.on{background:var(--ink-3);color:var(--parch);box-shadow:inset 0 0 0 1px var(--brass)}
.menu .opt{display:flex;flex-direction:column;gap:6px}
.menu .opt h2{font-size:14px;color:var(--parch-dim)}
.seg4{grid-template-columns:repeat(4,1fr)}
.row2{display:grid;grid-template-columns:1fr auto;gap:8px}
.first{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 6px 6px 12px;border-radius:10px;
  background:rgba(217,178,90,.16);border:1px solid var(--brass-dim);font-family:var(--serif);font-size:15px;font-weight:700}
.btn.small{min-height:44px;padding:0 12px;font-size:13px}
.howto{margin:0;padding:0 0 0 18px;font-size:12.5px;line-height:1.42;color:var(--parch-dim)}
.howto li{margin:0 0 3px}
.howto b{color:var(--parch)}
.menu .foot{font-size:11px;color:var(--muted)}
@media (max-height:430px){
  .menu{gap:18px}
  .title h1{font-size:clamp(36px,6.4vw,58px)}
  .title .lede{font-size:13.5px}
  .shield{width:44px;height:52px}
  .menu .box{padding:10px 12px;gap:7px;max-height:calc(100vh - 24px);overflow-y:auto}
  .menu .opt{gap:4px}
  .seg button{min-height:40px}
  .howto{font-size:11px;line-height:1.35}
  .howto li{margin:0 0 1px}
  .menu .foot{display:none}
}
@media (max-width:640px) and (orientation:portrait){
  .menu{grid-template-columns:1fr}
}

/* pause + end */
.dialog{padding:20px 22px;display:flex;flex-direction:column;gap:14px;min-width:min(340px,92vw);max-width:min(560px,96vw);max-height:100%;overflow:auto;align-items:stretch}
.dialog h2{margin:0;font-family:var(--serif);font-size:30px;line-height:1;text-align:center}
.dialog .sub{margin:-4px 0 0;text-align:center;color:var(--parch-dim);font-size:13.5px}
.dialog .btns{display:flex;gap:8px;justify-content:center;flex-wrap:wrap}
.end h2{font-size:clamp(38px,8vw,60px)}
.end.win h2{color:#ffe08a;text-shadow:0 3px 0 #5a3e10}
.end.lose h2{color:#f1a395;text-shadow:0 3px 0 #4a1a12}
.end table{border-collapse:collapse;width:100%;font-size:13px;font-variant-numeric:tabular-nums}
.end th,.end td{padding:4px 8px;text-align:right;border-bottom:1px solid rgba(217,178,90,.15)}
.end th:first-child,.end td:first-child{text-align:left;color:var(--parch-dim);font-weight:500}
.end thead th{font-weight:700;font-size:12px}
.end thead th.p0{color:var(--blue-l)} .end thead th.p1{color:var(--red-l)}
@media (max-height:430px){ .dialog{padding:12px 16px;gap:9px} .end h2{font-size:40px} .end table{font-size:12px} .end th,.end td{padding:2px 8px} }

/* rotate hint */
#rotate{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);padding:16px 18px;text-align:center;display:none;
  flex-direction:column;align-items:center;gap:8px;font-family:var(--serif);font-size:17px;z-index:50;pointer-events:none;width:min(280px,80vw)}
#rotate svg{width:44px;height:44px;stroke:var(--brass)}
@media (orientation:portrait) and (pointer:coarse){ #rotate{display:flex;background:#241d16;box-shadow:0 0 0 100vmax rgba(16,13,10,.82)} }
`;
