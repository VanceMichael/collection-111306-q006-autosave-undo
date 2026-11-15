let state=await(await fetch('/api/snapshot')).json();
function render(){const body=document.querySelector('#rows');body.replaceChildren();
 for(const id of state.order){const row=state.rows.find(value=>value.id===id);const line=document.createElement('tr');line.dataset.id=id;
  line.innerHTML=`<td>${id}</td><td><input data-column="price" value="${row.price}"></td><td><input data-column="quantity" value="${row.quantity}"></td><td data-column="total">${row.total}</td>`;
  line.querySelectorAll('input').forEach(input=>input.onchange=async()=>{document.querySelector('#save-status').textContent='保存中';
   try{const response=await fetch('/api/edit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,column:input.dataset.column,value:Number(input.value)})});state=await response.json();render();document.querySelector('#save-status').textContent='已保存 '+state.revision;}catch{document.querySelector('#save-status').textContent='确认丢失';}
  });body.append(line);
 }
 // 供同页面的接收器/机器人在页面上下文中只读核对当前 revision 与行数据；不改变门户交互
 window.portalState=state;
}
document.querySelector('#sort').onclick=()=>{state.order.reverse();render();};render();
window.portalReady=true;
