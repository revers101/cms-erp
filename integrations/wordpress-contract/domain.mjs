// SPDX-License-Identifier: GPL-3.0-or-later
// Portable domain contract. No database, HTTP server or WordPress dependency.
const transitions = {
  quote: {draft:['sent'], sent:['accepted','rejected'], accepted:[], rejected:[]},
  workorder: {planned:['active','cancelled'], active:['done','cancelled'], done:[], cancelled:[]}
};
function integer(value,min,max,label) {
  if (!Number.isSafeInteger(value) || value<min || value>max) throw new TypeError(label);
  return value;
}
export function calculateLines(lines) {
  if (!Array.isArray(lines) || lines.length>100) throw new TypeError('lines');
  let total=0n;
  const calculated=lines.map(line=>{
    if (!line || Array.isArray(line) || typeof line!=='object' || typeof line.description!=='string' || !line.description.trim() || line.description.length>500) throw new TypeError('description');
    if (Object.keys(line).some(key=>!['description','unit_cents','quantity_milli','total_cents'].includes(key))) throw new TypeError('unknown line field');
    const unit=integer(line.unit_cents,0,100000000,'unit_cents');
    const quantity=integer(line.quantity_milli,1,1000000,'quantity_milli');
    const cents=(BigInt(unit)*BigInt(quantity)+500n)/1000n;
    total+=cents;
    if (total>100000000000n) throw new RangeError('total_cents');
    return {description:line.description.trim(),unit_cents:unit,quantity_milli:quantity,total_cents:Number(cents)};
  });
  return {lines:calculated,total_cents:Number(total)};
}
export function assertTransition(kind,current,next) {
  const states=transitions[kind];
  if (!states || !Object.hasOwn(states,current) || !Object.hasOwn(states,next)) throw new TypeError('status');
  if (current!==next && !states[current].includes(next)) throw new Error('status conflict');
  return next;
}
export function assertVersion(expected,actual) {
  integer(expected,1,Number.MAX_SAFE_INTEGER,'version');
  integer(actual,1,Number.MAX_SAFE_INTEGER,'version');
  if (expected!==actual) throw new Error('version conflict');
}
export function optionalReference(value) {
  // Hardened porting requirement: absent is allowed; explicit null/zero is rejected.
  return value===undefined ? undefined : integer(value,1,Number.MAX_SAFE_INTEGER,'reference');
}
