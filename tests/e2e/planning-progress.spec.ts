import {test,expect,type Page} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type {Bootstrap} from '@kram/shared';
import {addDays,weekStartDate} from '@kram/time';
const testApi=process.env.E2E_API_URL||'http://127.0.0.1:8422';
test.setTimeout(60000);
test.beforeEach(async({request})=>{expect((await request.post(`${testApi}/api/v1/__test/reset`,{headers:{'X-Kram-Test':'reset-isolated-db'}})).ok()).toBeTruthy();});
async function seed(page:Page){
 await page.goto('/');await expect(page.getByRole('heading',{name:'Your account',exact:true})).toBeVisible();const auth=await(await page.request.get('/api/v1/auth/me')).json();
 const setup=await page.request.post('/api/v1/auth/setup',{headers:{'X-CSRF-Token':auth.csrfToken},data:{email:'v1-ui@kram.test',password:'synthetic-v1-ui-password-42',profileName:'Learning',timezone:'Asia/Kolkata'}});expect(setup.ok()).toBeTruthy();
 const csrf=(await(await page.request.get('/api/v1/auth/me')).json()).csrfToken;
 const data:Bootstrap=await(await page.request.get('/api/v1/bootstrap')).json();
 const skill=await(await page.request.post('/api/v1/skills',{headers:{'X-CSRF-Token':csrf},data:{name:'Systems',profileId:data.profiles[0]!.id,availableDays:[1,2,3,4,5,6,7]}})).json();
 const goal=await(await page.request.post('/api/v1/goals',{headers:{'X-CSRF-Token':csrf},data:{title:'A measured course',type:'milestone',unit:'minutes',targetQty:120,startDate:data.studyDate,skillId:skill.id,availableDays:[1,2,3,4,5,6,7]}})).json();
 const response=await page.request.post('/api/v1/tasks',{headers:{'X-CSRF-Token':csrf},data:{title:'Understand the scheduler',goalId:goal.id,estMinutes:60,earliestDate:data.studyDate}});expect(response.ok(),await response.text()).toBeTruthy();const task=await response.json();
 await page.goto('/');await expect(page.getByRole('heading',{name:'Your tasks',exact:true})).toBeVisible();return{task,goal,skill,csrf,date:data.studyDate};
}
async function accessible(page:Page){await expect(page.locator('html')).not.toHaveClass(/theme-crossfade/);expect((await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations).toEqual([]);}
test('a generated proposal preserves the timetable until acceptance and exposes reasons/history',async({page})=>{
 await seed(page);await page.goto('/planning');await page.getByRole('button',{name:'Generate plan',exact:true}).click();await expect(page.getByRole('button',{name:'Accept all changes',exact:true})).toBeVisible();
 expect((await(await page.request.get('/api/v1/timetable/global?from=2026-01-01&to=2026-12-31')).json()).filter((s:{applicationKey:string})=>s.applicationKey?.startsWith('plan:'))).toHaveLength(0);
 await page.locator('.plan-preview-item summary').first().click();await expect(page.locator('.plan-preview-item').first()).toContainText(/deadline|order|priority|Kept|Placed/i);
 await accessible(page);await page.getByRole('button',{name:'Accept all changes',exact:true}).click();await expect(page.getByText('Version 1 · active',{exact:true})).toBeVisible();await expect(page.getByRole('heading',{name:'Plan history',exact:true})).toBeVisible();
});
test('daily review previews without saving and closes the day with the accepted plan',async({page})=>{
 const{task}=await seed(page);await page.goto('/review');await page.getByRole('button',{name:'Continue to actual time'}).click();
 await page.locator(`#decision-${task.id}`).selectOption('partial');await page.locator(`#minutes-${task.id}`).fill('20');await page.getByRole('button',{name:'Preview tomorrow',exact:true}).click();await expect(page.getByRole('heading',{name:'Tomorrow, with reasons'})).toBeVisible();
 expect((await(await page.request.get(`/api/v1/tasks/${task.id}`)).json()).actualMinutes).toBe(0);
 await accessible(page);await page.getByRole('button',{name:'Accept all and continue'}).click();await page.getByRole('button',{name:'Close day and apply plan'}).click();await expect(page.getByRole('heading',{name:'Day closed',exact:true})).toBeVisible();
 expect((await(await page.request.get(`/api/v1/tasks/${task.id}`)).json()).actualMinutes).toBe(20);await page.goto('/');await expect(page.getByRole('heading',{name:'Your day is recorded'})).toBeVisible();
});
test('offline partial progress saves locally and replays exactly once when connected',async({page,context})=>{
 await page.addInitScript(()=>Object.defineProperty(crypto,'randomUUID',{value:undefined,configurable:true}));
 const{task}=await seed(page);await page.goto(`/tasks/${task.id}`);await expect(page.getByRole('heading',{name:'Understand the scheduler',exact:true})).toBeVisible();
 await expect.poll(()=>page.evaluate(async()=>{const req=indexedDB.open('kram-offline-v1');return new Promise<number>(resolve=>{req.onsuccess=()=>{const read=req.result.transaction('reads').objectStore('reads').count();read.onsuccess=()=>resolve(read.result);};});})).toBeGreaterThan(1);
 await context.setOffline(true);await page.getByRole('button',{name:'25%',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'Progress saved on this device'})).toBeVisible();await expect(page.getByText('15 min logged',{exact:false})).toBeVisible();
 await context.setOffline(false);await expect.poll(async()=>(await(await page.request.get(`/api/v1/tasks/${task.id}`)).json()).actualMinutes).toBe(15);
 const events=await(await page.request.get(`/api/v1/tasks/${task.id}/events`)).json();expect(events.filter((e:{kind:string})=>e.kind==='progress')).toHaveLength(1);
});
test('progress and recovery screens reflow in both themes without accessibility violations',async({page})=>{
 await seed(page);
 for(const theme of ['light','dark']){
  await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;document.documentElement.style.colorScheme=theme;},theme);
  for(const route of ['/progress','/data','/planning','/review']){await page.goto(route);await expect(page.locator('h1')).toBeVisible();await accessible(page);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);}
 }
 await page.setViewportSize({width:320,height:720});await page.evaluate(()=>document.documentElement.style.fontSize='32px');await page.goto('/review');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
});
test('weekly review respects Sunday boundaries and proposes the whole next week for approval',async({page})=>{
 const {skill,csrf,date}=await seed(page);
 const headers={'X-CSRF-Token':csrf};
 expect((await page.request.patch('/api/v1/settings',{headers,data:{weekStart:7,horizonDays:1,planningMode:'adaptive'}})).ok()).toBeTruthy();
 const currentWeek=weekStartDate(date,7),previousWeek=addDays(currentWeek,-7);
 const created=await page.request.post('/api/v1/goals',{headers,data:{title:'Two questions each day',type:'daily',unit:'questions',targetQty:2,estMinutes:30,startDate:previousWeek,skillId:skill.id,availableDays:[1,2,3,4,5,6,7]}});
 expect(created.ok(),await created.text()).toBeTruthy();
 await page.goto('/review?kind=weekly');
 await expect(page.getByLabel('Review week starting',{exact:true})).toHaveValue(previousWeek);
 await expect(page.getByRole('table',{name:'By profile',exact:true})).toContainText('Learning');
 await expect(page.getByRole('table',{name:'By skill',exact:true})).toContainText('Systems');
 await expect(page.getByRole('heading',{name:'Goal quota results',exact:true})).toBeVisible();
 await expect(page.getByRole('heading',{name:'Streak changes',exact:true})).toBeVisible();
 await expect(page.getByRole('heading',{name:'Deadline risks',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Next week',exact:true}).click();
 await expect(page.getByLabel('Review week starting',{exact:true})).toHaveValue(currentWeek);
 await expect(page.getByText('Week in progress',{exact:false})).toBeVisible();
 for(const theme of ['light','dark']){
  await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;document.documentElement.style.colorScheme=theme;},theme);
  await accessible(page);
 }
 await page.setViewportSize({width:320,height:720});await page.evaluate(()=>document.documentElement.style.fontSize='32px');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 const before=(await(await page.request.get('/api/v1/planning')).json()).activeVersionId;
 await page.getByRole('button',{name:'Propose the next allocation',exact:true}).click();
 await expect(page.getByRole('button',{name:'Accept all changes',exact:true})).toBeVisible();
 const planning=await(await page.request.get('/api/v1/planning')).json();
 expect(planning.activeVersionId).toBe(before);
 const proposal=planning.versions.find((version:{state:string})=>version.state==='proposed');
 expect(proposal.state).toBe('proposed');
 expect(proposal.toDate.slice(0,10)>=addDays(currentWeek,13)).toBe(true);
});
