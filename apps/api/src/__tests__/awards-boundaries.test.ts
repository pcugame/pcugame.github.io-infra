import { readFileSync, readdirSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { compareAwardProjects } from '../modules/awards/order.js';
const read=(path:string)=>readFileSync(new URL(path,import.meta.url),'utf8');
describe('award read and module boundaries',()=>{
 it('orders exhibition, awards, best rank, poster, legacy order, then ID',()=>{
  const p=(id:number,rank:number|null,poster=false,sortOrder=0,exhibitionId=1)=>({id,sortOrder,exhibitionId,exhibition:{sortOrder:0},awards:rank===null?[]:[{award:{id:1,name:'A',sortOrder:rank,builtinKey:'medal',assetId:null}}],poster:poster?{status:'READY',representations:[{role:'ORIGINAL',state:'READY'}]}:null});
  expect([p(9,null,true),p(4,2),p(2,1),p(8,null),p(1,0,false,0,2),p(3,1),p(7,null,false,1)].sort(compareAwardProjects).map(p=>p.id)).toEqual([2,3,4,9,8,7,1]);
 });
 it('keeps service/policy free of ORM and HTTP, and public cards free of admin imports',()=>{
  for(const file of ['service','policy'])expect(read(`../modules/awards/${file}.ts`)).not.toMatch(/from ['"][^'"]*(?:prisma|fastify|repository)/);
  expect(read('../../../web/src/components/project/ProjectCard.tsx')).not.toMatch(/features\/admin/);
  expect(read('../modules/awards/serialization.ts')).not.toContain('awardInclude');
  expect(readdirSync(new URL('../modules/awards/',import.meta.url))).toContain('composition.ts');
 });
});
