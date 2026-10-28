import test from 'node:test';
import assert from 'node:assert/strict';
import {ruleRunStatus} from '../ui/panels/rules/run-status.js';

test('execution status distinguishes no effects, successful effects, partial failures and old records',()=>{
  assert.equal(ruleRunStatus({status:'running',effectCount:0}),'处理中');
  assert.equal(ruleRunStatus({status:'done',effectCount:0}),'未执行操作');
  assert.equal(ruleRunStatus({status:'done',effectCount:1}),'已执行');
  assert.equal(ruleRunStatus({status:'done',actions:[]}),'流程结束','old live records have no action payloads and must not be inferred from actions');
  assert.equal(ruleRunStatus({status:'failed',effectCount:0}),'执行失败');
  assert.equal(ruleRunStatus({status:'failed',effectCount:1}),'部分完成');
  assert.equal(ruleRunStatus({status:'cancelled',effectCount:1}),'已停止 · 已执行部分操作');
});
