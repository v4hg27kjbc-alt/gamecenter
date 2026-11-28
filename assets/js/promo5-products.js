
(function(){
  try{
    var KEY='gc_promo5_session_v34';
    var box=document.getElementById('gcPromo5');
    if(!box) return;
    var timer=null;

    /* ===== 商品数据源：后台 /api/products（site:products:v1） =====
       成功 -> 用后台返回的 name/short/intro/price/badge/actions 重新渲染文档卡片；
       失败/超时/空数据 -> 保留下方静态内置文案，不破坏原有可用性。 */
    var GC_PRODUCTS_API='/api/products';
    var GC_PRODUCTS_API_FB='https://henry126923-admincenter.pages.dev/api/products';
    var GC_OFFLINE_TEXT='目前已下架，无法进行操作';
    var gpEsc=function(v){
      return String(v==null?'':v).replace(/[&<>"']/g,function(ch){
        return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch];
      });
    };
    var gpCardHtml=function(it,idx){
      var off=(it&&it.enabled===false);
      var name=gpEsc(it.name||it.short||('商品 '+idx));
      var sub=gpEsc(it.short||'');
      var price=gpEsc(it.price||'');
      var badge=gpEsc(it.badge||'');
      var intro=gpEsc(it.intro||'');
      var isFree=/免费|free|^0/.test(String(it.price||'').toLowerCase());
      var acts=(it.actions&&it.actions.length)?it.actions.slice(0):[];
      if(!acts.length){
        if(it.readHref) acts.push({label:'已有券码 · 进入阅读',href:it.readHref,style:'ghost'});
        if(it.payHref) acts.push({label:'付款解锁',href:it.payHref,style:'primary'});
      }
      var btns=[];
      if(off){ btns.push('<span class="gp-off-btn">'+GC_OFFLINE_TEXT+'</span>'); } else {
      for(var i=0;i<acts.length;i++){
        var a=acts[i];
        if(!a||!a.href) continue;
        var cls=(a.style==='primary')?'gp-buy':'gp-read';
        var ext=/^https?:/i.test(a.href);
        btns.push('<a class="'+cls+'" href="'+gpEsc(a.href)+'"'+(ext?' target="_blank" rel="noopener"':'')+'>'+gpEsc(a.label||'查看')+'</a>');
      }
      }
      return '<div class="gp-doc" data-doc="'+gpEsc(it.id||('p'+idx))+'"'+(off?' data-gc-offline="1"':'')+'>'
        + '<div class="gp-sum"><span class="gp-idx">'+idx+'</span>'
        + '<div class="gp-name"><b>'+name+'</b>'+(sub?'<span>'+sub+'</span>':'')+'</div>'
        + (off?'<span class="gp-off-tag">'+GC_OFFLINE_TEXT+'</span>':'')+ (badge?'<span class="gp-tag">'+badge+'</span>':'')
        + ((!off&&price)?'<span class="gp-price'+(isFree?' free':'')+'">'+price+'</span>':'')
        + '<span class="gp-arrow">&#9654;</span>'
        + '</div>'
        + '<div class="gp-detail">'
        + (intro?'<p>'+intro+'</p>':'')
        + (btns.length?'<div class="gp-btns">'+btns.join('')+'</div>':'')
        + '</div></div>';
    };
    /* 文档分别展开：单开模式，点同一份可收起 */
    var gpBindDocs=function(){
      var docs=box.querySelectorAll('.gp-doc');
      for(var i=0;i<docs.length;i++){
        (function(doc){
          var sum=doc.querySelector('.gp-sum');
          if(!sum) return;
          sum.addEventListener('click',function(){
            var on=doc.classList.contains('on');
            for(var j=0;j<docs.length;j++) docs[j].classList.remove('on');
            if(!on) doc.classList.add('on');
            if(timer){ clearTimeout(timer); timer=null; }
          });
        })(docs[i]);
      }
    };
    gpBindDocs();

    var gpLoadProducts=function(){
      if(!window.fetch||!window.JSON) return;
      var ctl=null; try{ ctl=new AbortController(); }catch(e){}
      var opt={cache:'no-store',credentials:'omit'};
      if(ctl) opt.signal=ctl.signal;
      var to=setTimeout(function(){ if(ctl){ try{ ctl.abort(); }catch(e){} } },6000);
      fetch(GC_PRODUCTS_API,opt).then(function(r){
        if(!r||!r.ok) throw new Error('http '+ (r&&r.status));
        return r.json();
      }).catch(function(){
        return fetch(GC_PRODUCTS_API_FB,opt).then(function(r2){
          if(!r2||!r2.ok) throw new Error('http '+ (r2&&r2.status));
          return r2.json();
        });
      }).then(function(d){
        clearTimeout(to);
        if(!d||d.ok===false||!d.items||!d.items.length) return;
        var list=[];
        for(var i=0;i<d.items.length;i++){
          var it=d.items[i];
          if(it&&(it.id||it.name)) list.push(it);
        }
        if(!list.length) return;
        list.sort(function(a,b){ return (a.order||0)-(b.order||0); });
        var html='';
        for(var j=0;j<list.length;j++) html+=gpCardHtml(list[j],j+1);
        var olds=box.querySelectorAll('.gp-doc');
        for(var k=olds.length-1;k>=0;k--){ if(olds[k].parentNode) olds[k].parentNode.removeChild(olds[k]); }
        var foot=box.querySelector('.gp-foot');
        if(foot) foot.insertAdjacentHTML('beforebegin',html);
        else box.insertAdjacentHTML('beforeend',html);
        gpBindDocs();
      }).catch(function(){ clearTimeout(to); /* 回退内置文案 */ });
    };
    gpLoadProducts();

    var seen=false; try{ seen = sessionStorage.getItem(KEY)==='1'; }catch(e){}
    if(seen) return;
    var hide=function(remember){
      box.classList.remove('show');
      if(timer){ clearTimeout(timer); timer=null; }
      if(remember){ try{ sessionStorage.setItem(KEY,'1'); }catch(e){} }
    };
    setTimeout(function(){ box.classList.add('show'); }, 1500);

    var c=document.getElementById('gcPromo5Close');
    if(c) c.addEventListener('click',function(){ hide(true); });
    /* 委托：动态渲染后的链接同样点击即关窗 */
    box.addEventListener('click',function(ev){
      var t=ev.target;
      while(t&&t!==box){
        if(t.tagName==='A'){ hide(true); return; }
        t=t.parentNode;
      }
    });

    timer=setTimeout(function(){ if(box.classList.contains('show')) hide(true); }, 20000);
  }catch(e){}
})();
