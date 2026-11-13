#!/usr/bin/env python3
"""Real Telegram E2E. Credentials/settings/receipts live outside the checkout.
Usage: python3 scripts/telegram-e2e.py --setup|--run --private-dir /absolute/private/path
Requires Python stdlib, installed Wrangler, and an already authenticated test account.
Never prints remote error bodies (they can include tokens or personal data).
"""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import time
import urllib.request
import urllib.error
import uuid

ROOT = Path(__file__).resolve().parents[1]
WORKER = 'sangha-mantra-e2e-test'
DATABASE = 'sangha-mantra-e2e-test'
CAMPAIGN = 'sangha-e2e-test'


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


class Stand:
    def __init__(self, folder):
        self.folder = Path(folder).expanduser().resolve()
        require(not self.folder.is_relative_to(ROOT.parent), 'Private directory must be outside workspace')
        self.folder.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self.folder, 0o700)
        self.credentials = self.read('credentials.json')
        self.settings = self.read('settings.json')
        self.receipt = self.read('deployment.json') if (self.folder/'deployment.json').exists() else None
        self.offset = None
        self.observed = []
        self.owned = []
        self.checks = []
        self.run_id = str(uuid.uuid4())

    def read(self, name):
        path = self.folder/name
        require(path.stat().st_mode & 0o077 == 0, 'Private file permissions must be 0600')
        return json.loads(path.read_text())

    def save(self, name, data):
        fd = os.open(self.folder/name, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
        with os.fdopen(fd, 'w') as out:
            json.dump(data, out, ensure_ascii=False, indent=2)

    def api(self, role, method, **params):
        url = 'https://api.telegram.org/bot'+self.credentials[role+'_token']+'/'+method
        request = urllib.request.Request(url, data=json.dumps(params).encode(), headers={'Content-Type':'application/json','User-Agent':'sangha-e2e-test/1.0'})
        try:
            with urllib.request.urlopen(request, timeout=35) as response:
                data = json.load(response)
        except urllib.error.HTTPError as e:
            raise RuntimeError(f'Telegram {role}/{method} HTTP {e.code}; body withheld') from None
        except Exception:
            raise RuntimeError(f'Telegram {role}/{method} transport failed; outcome may be uncertain') from None
        require(data.get('ok'), f'Telegram {role}/{method} rejected; body withheld')
        return data['result']

    def cli(self, *args, configured=True, stdin=None):
        command = ['bun', str(ROOT/'node_modules/wrangler/bin/wrangler.js'), *args]
        if configured:
            config=self.read('wrangler.json')
            test=config.get('env',{}).get('test',{})
            bindings=test.get('d1_databases',[])
            require(test.get('name')==WORKER and test.get('account_id')==self.settings['account_id']
                    and test.get('vars',{}).get('DEPLOYMENT_ENV')=='test'
                    and len(bindings)==1 and bindings[0].get('database_name')==DATABASE
                    and bindings[0].get('database_id')==self.receipt['database_id']
                    and test['vars'].get('EXPECTED_D1_ID')==self.receipt['database_id']
                    and test['vars'].get('EXPECTED_BOT_ID')==str(self.settings['receiver_id'])
                    and test['vars'].get('CAMPAIGN_ID')==CAMPAIGN
                    and config.get('main')==str(ROOT/'src/worker.ts'), 'Unsafe private TEST config')
            command += ['--config', str(self.folder/'wrangler.json'), '--env', 'test']
        result = subprocess.run(command, input=stdin, text=True, capture_output=True, cwd=ROOT,
                                env={**os.environ, 'WRANGLER_SEND_METRICS':'false', 'CI':'true',
                                     'CLOUDFLARE_ACCOUNT_ID': self.settings['account_id']})
        require(result.returncode == 0, f'Wrangler {args[0:2]} failed; raw output withheld')
        return result.stdout

    def sql(self, statement):
        result = json.loads(self.cli('d1','execute','DB','--remote','--command',statement,'--json'))
        return result[0]['results']

    def verify_bots(self):
        identities = {}
        for role in ['receiver','sender']:
            me = self.api(role,'getMe')
            require(me['id'] == self.settings[role+'_id'] and me.get('is_bot'), f'{role} identity mismatch')
            member = self.api(role,'getChatMember',chat_id=self.settings['chat_id'],user_id=me['id'])
            require(member['status']=='administrator', f'{role} must be test group administrator')
            identities[role] = me
        require(identities['receiver']['id'] != identities['sender']['id'], 'Distinct bots required')
        chat = self.api('receiver','getChat',chat_id=self.settings['chat_id'])
        require(chat['type'] == 'supergroup' and chat['title'] == self.settings['chat_title'], 'Test group mismatch')
        require(not self.api('sender','getWebhookInfo')['url'], 'Sender webhook is owned elsewhere')
        return identities

    def verify_target(self):
        r = self.receipt
        require(r and r['worker']==WORKER and r['database']==DATABASE and r['campaign']==CAMPAIGN
                and r['receiver_id']==self.settings['receiver_id'] and r['chat_id']==self.settings['chat_id']
                and re.fullmatch(r'https://sangha-mantra-e2e-test\.[a-z0-9-]+\.workers\.dev',r['origin']), 'Unsafe TEST receipt')
        actual = json.loads(self.cli('d1','info',DATABASE,'--json'))
        require(actual['uuid']==r['database_id'] and actual['name']==DATABASE, 'Provider TEST D1 identity mismatch')
        rows = self.sql('SELECT * FROM deployment_identity WHERE singleton=1')
        require(len(rows)==1 and rows[0]['environment']=='test' and rows[0]['database_id']==r['database_id']
                and rows[0]['bot_id']==self.settings['receiver_id'] and rows[0]['campaign_id']==CAMPAIGN
                and rows[0]['source_chat_ids']==str(self.settings['chat_id'])
                and rows[0]['report_chat_id']==self.settings['chat_id'], 'Runtime TEST identity mismatch')

    def setup(self):
        identities = self.verify_bots()
        previous = self.api('receiver','getWebhookInfo')['url']
        allowed = self.settings.get('previous_test_webhook','')
        require(not previous or previous==allowed or (self.receipt and previous==self.receipt['origin']+'/webhook'),
                'Unknown webhook; refusing takeover')
        if not self.receipt:
            existing = json.loads(self.cli('d1','list','--json',configured=False))
            require(not any(d['name']==DATABASE for d in existing), 'Unowned TEST database; inspect before adoption')
            out = self.cli('d1','create',DATABASE,'--no-update-config',configured=False)
            match = re.search(r'"database_id"\s*:\s*"([a-f0-9-]{36})"',out)
            require(match, 'D1 created; UUID unavailable, inspect before retry')
            marker = self.api('receiver','sendMessage',chat_id=self.settings['chat_id'],text='TEST E2E: начало отдельной тестовой кампании. История группы не импортируется.')
            self.receipt = dict(worker=WORKER,database=DATABASE,campaign=CAMPAIGN,database_id=match[1],
                                receiver_id=identities['receiver']['id'],chat_id=self.settings['chat_id'],
                                first_message_id=marker['message_id']+1,original_not_before=marker['date'],
                                start_day=dt.datetime.now(dt.timezone.utc).date().isoformat(),origin='')
            self.save('deployment.json',self.receipt)
        r=self.receipt
        config = dict(main=str(ROOT/'src/worker.ts'),compatibility_date='2026-07-01',workers_dev=True,
                      observability={'enabled':True},env={'test':dict(name=WORKER,account_id=self.settings['account_id'],
                      vars=dict(DEPLOYMENT_ENV='test',EXPECTED_D1_ID=r['database_id'],EXPECTED_BOT_ID=str(r['receiver_id']),
                                CAMPAIGN_ID=CAMPAIGN,CAMPAIGN_START=r['start_day'],TIMEZONE='Europe/Moscow',REPORT_TIME='00:05',
                                GOAL='1000000',MAX_AMOUNT='1000000',ALLOWED_CHAT_IDS=str(r['chat_id']),REPORT_CHAT_ID=str(r['chat_id']),
                                ADMIN_IDS=str(self.settings['sender_id']),TEST_SENDER_BOT_ID=str(self.settings['sender_id']),
                                TEST_SENDER_CHAT_ID=str(r['chat_id'])),
                      d1_databases=[dict(binding='DB',database_name=DATABASE,database_id=r['database_id'],migrations_dir=str(ROOT/'migrations'))],
                      triggers={'crons':['*/5 * * * *']})})
        self.save('wrangler.json',config)
        actual=json.loads(self.cli('d1','info',DATABASE,'--json'))
        require(actual['uuid']==r['database_id'], 'Wrong TEST D1 before migration')
        self.cli('d1','migrations','apply','DB','--remote')
        chat=r['chat_id'];bot=r['receiver_id'];actor=self.settings['sender_id'];now=int(time.time()*1000)
        self.sql(f"""INSERT INTO deployment_identity VALUES(1,'test','{r['database_id']}','{CAMPAIGN}',{bot},'{chat}',{chat}) ON CONFLICT DO NOTHING;
INSERT INTO campaigns(id,timezone,start_day,goal,report_chat_id) VALUES('{CAMPAIGN}','Europe/Moscow','{r['start_day']}',1000000,{chat}) ON CONFLICT DO NOTHING;
INSERT INTO chat_aliases VALUES({chat},'{CAMPAIGN}') ON CONFLICT DO NOTHING;
INSERT INTO automatic_intake_boundaries VALUES('{CAMPAIGN}',{chat},{r['first_message_id']},{r['original_not_before']},'Fresh E2E marker; no historical enrollment',{actor},{now}) ON CONFLICT DO NOTHING;
INSERT INTO campaign_controls(campaign_id,silent,changed_at,changed_by) VALUES('{CAMPAIGN}',1,{now},{actor}) ON CONFLICT DO NOTHING;""")
        out=self.cli('deploy')
        origin=re.search(r'https://sangha-mantra-e2e-test\.[a-z0-9-]+\.workers\.dev',out)
        require(origin,'TEST deployed; origin unavailable')
        r['origin']=origin[0];self.save('deployment.json',r)
        self.verify_target()
        if not (self.folder/'worker-secrets.json').exists():
            self.save('worker-secrets.json',dict(BOT_TOKEN=self.credentials['receiver_token'],WEBHOOK_SECRET=secrets.token_urlsafe(32)))
        self.cli('secret','bulk',stdin=json.dumps(self.read('worker-secrets.json')))
        self.health()
        self.api('receiver','setWebhook',url=r['origin']+'/webhook',secret_token=self.read('worker-secrets.json')['WEBHOOK_SECRET'],
                 allowed_updates=['message','edited_message','my_chat_member','callback_query'],drop_pending_updates=False,max_connections=5)
        require(self.api('receiver','getWebhookInfo')['url']==r['origin']+'/webhook','Webhook readback mismatch')
        print('Isolated TEST Worker/D1 provisioned and webhook verified',flush=True)

    def health(self):
        request=urllib.request.Request(self.receipt['origin']+'/health',headers={'User-Agent':'sangha-e2e-test/1.0','X-Telegram-Bot-Api-Secret-Token':self.read('worker-secrets.json')['WEBHOOK_SECRET']})
        with urllib.request.urlopen(request,timeout=25) as response:
            body=json.load(response)
        require(body['campaign']==CAMPAIGN,'Wrong health identity')
        return body

    def collect(self):
        args=dict(timeout=0,allowed_updates=['message','edited_message'])
        if self.offset is not None: args['offset']=self.offset
        for update in self.api('sender','getUpdates',**args):
            self.offset=update['update_id']+1
            message=update.get('message',update.get('edited_message',{}))
            if message.get('from',{}).get('id')==self.settings['receiver_id']:
                self.observed.append(message)

    def wait(self, predicate, description, seconds=40):
        deadline=time.monotonic()+seconds
        while time.monotonic()<deadline:
            self.collect()
            value=predicate()
            if value: return value
            time.sleep(1)
        raise RuntimeError('Timed out: '+description)

    def send(self,text,private=False):
        chat='@'+self.identities['receiver']['username'] if private else self.settings['chat_id']
        m=self.api('sender','sendMessage',chat_id=chat,text=text)
        self.owned.append((m['chat']['id'],m['message_id']))
        return m

    def state(self):
        # Read actual D1, never write synthetic contributions or test outcomes.
        rows=self.sql(f"""SELECT json_object(
 'total',(SELECT CAST(COALESCE(SUM(effective_amount),0) AS TEXT) FROM contributions WHERE campaign_id='{CAMPAIGN}'),
 'silent',(SELECT silent FROM campaign_controls WHERE campaign_id='{CAMPAIGN}'),
 'inputs',json((SELECT json_group_array(json(detail)) FROM operational_events WHERE kind='TEST_BOT_INPUT' AND campaign_id='{CAMPAIGN}')),
 'notices',json((SELECT json_group_array(json_object('key',notice_key,'reply',reply_message_id,'chat',chat_id,'state',state,'hold',publication_hold,'sent',sent_message_id,'body',body)) FROM notices WHERE campaign_id='{CAMPAIGN}')),
 'contributions',json((SELECT json_group_array(json_object('id',message_id,'amount',effective_amount,'state',source_state)) FROM contributions WHERE campaign_id='{CAMPAIGN}')),
 'reports',json((SELECT json_group_array(json_object('day',day,'state',status,'hold',publication_hold,'attempts',attempt_count)) FROM daily_reports WHERE campaign_id='{CAMPAIGN}'))
 ) AS evidence""")
        return json.loads(rows[0]['evidence'])

    def input(self,m,edited=False):
        kind='edited_message' if edited else 'message'
        def find():
            for envelope in self.state()['inputs']:
                value=envelope.get(kind,{})
                if (m['chat']['type']=='private' and value.get('date')==m['date'] or m['chat']['type']!='private' and value.get('message_id')==m['message_id']) and value.get('chat',{}).get('id')==(self.settings['sender_id'] if m['chat']['type']=='private' else m['chat']['id']) and value.get('text')==m.get('text'):
                    return envelope
        return self.wait(find,'real Telegram input')

    def command(self,text,contains):
        m=self.send(text,private=True)
        self.input(m)
        def response():
            return next((x for x in self.observed if x['chat']['type']=='private'
                         and x.get('reply_to_message',{}).get('message_id')==m['message_id'] and contains.casefold() in x.get('text','').casefold()),None)
        result=self.wait(response,'private admin reply')
        self.checks.append({'kind':'telegram-admin','command':text.split()[0],'passed':True})
        return result

    def replay(self,envelope):
        request=urllib.request.Request(self.receipt['origin']+'/webhook',data=json.dumps(envelope).encode(),
                                      headers={'User-Agent':'sangha-e2e-test/1.0','Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':self.read('worker-secrets.json')['WEBHOOK_SECRET']})
        with urllib.request.urlopen(request,timeout=25) as response: require(response.status==200,'Replay rejected')

    def run(self):
        self.identities=self.verify_bots();self.verify_target();self.health()
        require(self.api('receiver','getWebhookInfo')['url']==self.receipt['origin']+'/webhook','Wrong TEST webhook')
        # Prove reply visibility before interpreting any absence as silence.
        self.collect()
        probe=self.api('receiver','sendMessage',chat_id=self.settings['chat_id'],text='TEST E2E: проверка наблюдения ответов.')
        self.owned.append((self.settings['chat_id'],probe['message_id']))
        self.wait(lambda:any(x['message_id']==probe['message_id'] and x['chat']['id']==self.settings['chat_id'] for x in self.observed),'receiver-to-sender visibility')
        print('Real receiver replies are observable by sender',flush=True)
        baseline=int(self.state()['total']);expected=baseline
        original=None;latest=None;valid_message=None
        for silent in [False,True]:
            self.command('/silent on' if silent else '/silent off','включена' if silent else 'выключена')
            self.command('/silent status','включена' if silent else 'выключена')
            if silent:
                self.cli('deploy')  # fresh deployment of same code; actual persisted state, not a local reinitialization
                require(self.health()['silent'] is True,'Silence lost after redeployment')
                self.checks.append({'kind':'cloud-redeployment','silentPersisted':True})
            # Avoid same-second OFF watermark; Telegram timestamps have second precision.
            time.sleep(1.2)
            for text,amount,warn in [('1000',1000,False),('1000🙏',1000,False),('10 и 10',0,True),('1000 2000',0,True),('1.5',0,True),('0',0,True),('Привет',0,False)]:
                m=self.send(text); envelope=self.input(m);expected+=amount
                state=self.state(); require(int(state['total'])==expected,'D1 total mismatch')
                notices=[n for n in state['notices'] if n['chat']==self.settings['chat_id'] and n['reply']==m['message_id']]
                require(len(notices)==int(warn),'Warning outbox mismatch')
                if warn and silent:
                    require(notices[0]['hold']==1 and notices[0]['state']=='PENDING','Silence did not hold warning')
                self.collect()
                if silent or not warn:
                    require(not any(x['chat']['id']==self.settings['chat_id'] and x.get('reply_to_message',{}).get('message_id')==m['message_id'] for x in self.observed),'Unexpected automatic reply')
                if warn and not silent:
                    self.wait(lambda:any(x['chat']['id']==self.settings['chat_id'] and x.get('reply_to_message',{}).get('message_id')==m['message_id'] for x in self.observed),'actual warning')
                self.replay(envelope) # explicit transport fault injection, separate from Telegram delivery
                if text=='1000': valid_message=m;original=envelope
                self.checks.append({'kind':'telegram-matrix','silent':silent,'text':text,'message_id':m['message_id'],'expected_total':str(expected),'warning':warn and not silent})
                print(f'Matrix silent={silent}: {text} passed',flush=True)
            # Media caption must not be counted. A local generated tiny PNG avoids external dependencies.
            # sendPhoto uses multipart, implemented by the companion helper below.
            media=self.photo();self.input(media)
            require(int(self.state()['total'])==expected,'Media caption counted')
            video=self.video();self.input(video)
            require(int(self.state()['total'])==expected,'Video caption counted')
            self.checks.append({'kind':'telegram-media','silent':silent,'photoAndVideoIgnored':True})
            for text,new_amount in [('2000',2000),('10 и 10',0),('108',108),('Привет',0),('108',108)]:
                time.sleep(1.2)
                valid_message=self.api('sender','editMessageText',chat_id=self.settings['chat_id'],message_id=valid_message['message_id'],text=text)
                latest=self.input(valid_message,edited=True)
                if text=='2000': stale_edit=latest
                expected+=new_amount-(1000 if text=='2000' else prior_amount)
                prior_amount=new_amount
                require(int(self.state()['total'])==expected,'Edited total mismatch')
                self.replay(latest)
                self.checks.append({'kind':'telegram-edit','silent':silent,'text':text,'message_id':valid_message['message_id'],'passed':True})
            self.replay(stale_edit)  # captured older edit after newest edit
            self.replay(original)  # old original after actual edits
            require(int(self.state()['total'])==expected,'Old original resurrected contribution')
        # Check default /silent and repeated ON, readable UI and correction paths over real bot private messages.
        self.command('/silent','включена');self.command('/silent on','включена')
        self.command('/status','Накоплено:');self.command('/status json','summary')
        self.command('/recent','Последние')
        chat=self.settings['chat_id'];mid=valid_message['message_id']
        self.command(f'/inspect {chat} {mid}','Фактически учтено:')
        self.command(f'/inspect {chat} {mid} json','source_state')
        self.command(f'/override {chat} {mid} 7 E2E verified correction','Коррекция сохранена');expected+=7-108
        require(int(self.state()['total'])==expected,'Override mismatch')
        time.sleep(1.2)
        edited=self.api('sender','editMessageText',chat_id=chat,message_id=mid,text='216')
        self.input(edited,edited=True)
        require(int(self.state()['total'])==expected,'Source edit overwrote administrative correction')
        self.command(f'/release {chat} {mid} E2E verified source','Административное значение снято');expected+=216-7
        imported_at=dt.datetime.fromtimestamp(media['date'],dt.timezone.utc).isoformat()
        self.command(f"/import {chat} {media['message_id']} 108 {imported_at} E2E verified historical import",'Исторический вклад сохранён')
        expected+=108
        require(int(self.state()['total'])==expected,'Import mismatch')
        self.command('/reports','отчёт');self.command('/notices','уведомлен')
        self.command('/help','Для участников')
        before=self.state();sent_before={n['key'] for n in before['notices'] if n['chat']<0 and n['state']=='SENT'}
        self.command('/silent off','выключена');time.sleep(3);self.collect()
        after=self.state()
        require({n['key'] for n in after['notices'] if n['chat']<0 and n['state']=='SENT'}==sent_before,'Held warnings burst after OFF')
        require(all(n['hold'] for n in after['notices'] if n['chat']<0 and n['state']=='PENDING'),'Backlog not held')
        require(int(after['total'])==expected,'Final total mismatch')
        self.command('/silent on','включена')
        self.checks.append({'kind':'transport-fault-injection','duplicatesAndStaleCapturedEnvelopes':True,'notNativeTelegramRedelivery':True})
        import hashlib
        fingerprint=hashlib.sha256()
        for path in sorted(list((ROOT/'src').glob('*.ts'))+list((ROOT/'migrations').glob('*.sql'))):
            fingerprint.update(str(path.relative_to(ROOT)).encode()+b'\0'+path.read_bytes())
        self.save('run-'+self.run_id+'.json',dict(source_fingerprint=fingerprint.hexdigest(),run_id=self.run_id,passed=True,checks=self.checks,baseline=str(baseline),total=str(expected),
                  unverified=['normal human Telegram sender','actual Telegram duplicate/reordered delivery (captured-envelope injection only)','live cron during long silence','inline callback UI by a human'],
                  deployment=json.loads(self.cli('deployments','list','--json'))[-1]))
        print('Real Telegram E2E passed; private receipt: run-'+self.run_id+'.json',flush=True)

    def video(self):
        path=self.folder/'test-video.mp4'
        result=subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-f','lavfi','-i',
                               'color=c=black:s=32x32:d=1','-an','-c:v','libx264','-pix_fmt','yuv420p',str(path)],capture_output=True)
        require(result.returncode==0,'ffmpeg test video generation failed')
        return self.upload('video',path.read_bytes(),'test.mp4','video/mp4')

    def photo(self):
        import base64
        png=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=')
        return self.upload('photo',png,'test.png','image/png')

    def upload(self,kind,content,filename,mime):
        boundary='e2e'+uuid.uuid4().hex
        body=b''
        for key,value in [('chat_id',str(self.settings['chat_id'])),('caption','1000')]:
            body+=f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode()
        body+=f'--{boundary}\r\nContent-Disposition: form-data; name="{kind}"; filename="{filename}"\r\nContent-Type: {mime}\r\n\r\n'.encode()+content+f'\r\n--{boundary}--\r\n'.encode()
        request=urllib.request.Request('https://api.telegram.org/bot'+self.credentials['sender_token']+'/send'+kind.title(),data=body,headers={'Content-Type':'multipart/form-data; boundary='+boundary})
        try:
            with urllib.request.urlopen(request,timeout=35) as response: result=json.load(response)
        except Exception: raise RuntimeError('Telegram media upload failed; body withheld') from None
        require(result.get('ok'),'Media upload rejected')
        self.owned.append((self.settings['chat_id'],result['result']['message_id']))
        return result['result']


if __name__=='__main__':
    os.umask(0o077)
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--private-dir',required=True)
    mode=parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--setup',action='store_true');mode.add_argument('--run',action='store_true')
    args=parser.parse_args()
    stand=None
    try:
        stand=Stand(args.private_dir)
        stand.setup() if args.setup else stand.run()
    except Exception as error:
        # No traceback or exception object from HTTP/subprocess libraries can reveal a token URL.
        print(str(error) if isinstance(error,RuntimeError) else 'E2E failed; sensitive exception withheld',file=sys.stderr)
        if stand:
            try:
                stand.identities=stand.verify_bots()
                stand.send('/silent on',private=True)
            except Exception:
                print('Could not request TEST silence after failure; inspect test state',file=sys.stderr)
            stand.save('failure-'+stand.run_id+'.json',dict(run_id=stand.run_id,passed=False,checks=stand.checks))
        sys.exit(1)
