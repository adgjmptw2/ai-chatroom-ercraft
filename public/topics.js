import { appUrl } from './base-path.js';

const $ = id => document.getElementById(id);
let admin = false;
let enabled = false, submitting = false;
const mailLabels = {
  saved: '이메일 알림: 저장만 됨 (전송 시도 없음)',
  sent: '이메일 알림: 전송 서비스 접수 확인',
  failed: '이메일 알림: 전송 확인 실패 (자동 재전송 없음)',
  pending: '이메일 알림: 결과 미확인 (처리 중이거나 중단됨, 자동 재전송 없음)',
};
function submissionNotice(result) {
  const saved = result.duplicate === true ? '이미 접수된 제보입니다.' : '제보를 접수했습니다.';
  const mail = {
    sent: '관리자에게 이메일 알림을 요청했습니다.',
    failed: '이메일 알림 전송을 확인하지 못했지만, 제보는 검토함에 저장되었습니다.',
    pending: '제보는 저장되었습니다. 이메일 알림 결과는 아직 확인되지 않았습니다.',
  }[result.mailStatus] || '검토함에 저장되었습니다.';
  return `${saved} ${mail} 관리자 검토 후 대화 소재로 사용될 수 있습니다.`;
}
async function api(path, data) {
  const response = await fetch(appUrl(path), { credentials: 'same-origin', ...(data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  return body;
}
function card(item) {
  const box = document.createElement('article');
  const heading = document.createElement('h2'); heading.textContent = item.title;
  const text = document.createElement('p'); text.textContent = item.text;
  box.append(heading, text);
  if (item.sourceUrl) {
    const link = document.createElement('a'); link.textContent = '출처 보기'; link.href = item.sourceUrl; link.target = '_blank'; link.rel = 'noopener noreferrer nofollow'; box.append(link);
  }
  return box;
}
async function refresh() {
  const data = await api('/api/topics');
  $('recent').replaceChildren(...data.items.map(card));
  if (!data.items.length) $('recent').textContent = '아직 전해진 이야기가 없습니다.';
  enabled = data.enabled === true;
  $('submit-button').disabled = submitting || !enabled;
  if (admin) {
    const queue = await api('/api/admin/topics');
    $('review-list').replaceChildren(...queue.items.map(item => {
      const box = card(item), status = document.createElement('p');
      status.textContent = ({ pending: '검토 대기', approved: '승인됨', rejected: '보류됨', exposed: '전달됨' })[item.status] || '';
      box.append(status);
      const mail = document.createElement('p'); mail.textContent = mailLabels[item.mailStatus] || mailLabels.saved;
      box.append(mail);
      if (item.status === 'pending') for (const [action, name] of [['approve', '승인'], ['reject', '보류']]) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = name;
        button.onclick = async () => { button.disabled = true; try { await api('/api/admin/topics', { id: item.id, version: item.version, action }); await refresh(); } catch (error) { $('notice').textContent = error.message; button.disabled = false; } };
        box.append(button);
      }
      return box;
    }));
    if (!queue.items.length) $('review-list').textContent = '제보가 없습니다.';
  }
}
$('submit-form').onsubmit = async event => {
  event.preventDefault();
  if (submitting || !enabled) return;
  submitting = true; $('submit-button').disabled = true;
  try {
    const body = { title: $('title').value, text: $('text').value, sourceUrl: $('sourceUrl').value, consent: $('consent').checked };
    const owner = admin && $('as-owner').checked;
    const result = await api(owner ? '/api/admin/topics' : '/api/topics/submit', { ...body, ...(owner ? { action: 'submit', kind: 'owner' } : {}) });
    if (result.accepted !== true) throw new Error('제보 접수 여부를 확인하지 못했습니다.');
    $('submit-form').reset(); $('notice').textContent = submissionNotice(result);
    try { await refresh(); }
    catch { $('notice').textContent += ' 목록을 새로 불러오지 못했습니다.'; }
  } catch (error) { $('notice').textContent = error.message; }
  finally { submitting = false; $('submit-button').disabled = !enabled; }
};
$('reload').onclick = () => refresh().catch(error => { $('notice').textContent = error.message; });
try {
  admin = (await api('/api/session')).authenticated === true;
  $('admin').hidden = !admin;
  await refresh();
} catch (error) { $('notice').textContent = error.message; }
