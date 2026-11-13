export function cellIdentity(row, column) {
  if (!['price','quantity','total'].includes(column)) throw new Error('未知单元格');
  return `${row}:${column}`;
}
export function preview(data) {
 return data.rows.map(row=>({id:row.id,price:row.price,quantity:row.quantity,total:row.total}));
}
