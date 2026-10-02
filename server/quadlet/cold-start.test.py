#!/usr/bin/env python3
"""Opt-in native-graph cold-start surrogate; no Podman or host network probes.

Registers the entire uniquely named graph in one user-manager transaction using
auxiliary transient units. Keeps native restart/start-limit timings. A local
clock-driven command double models network-online preceding stable routing and
Tailscale. This is systemd ordering evidence, not a production reboot test.
"""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
sys.dont_write_bytecode = True
from generator_checks import select_generator, generate, assert_graph, settings, words, POD, WORKLOADS

HERE = Path(__file__).resolve().parent


def string_property(name, value): return [name, 's', value]
def exec_property(name, path, arguments):
    return [name, 'a(sasb)', '1', path, str(len(arguments)), *arguments, 'false']


@unittest.skipUnless(os.environ.get('RUN_QUADLET_LIFECYCLE_TESTS') == '1', 'opt-in local systemd fixture')
class ColdStart(unittest.TestCase):
    def test_delayed_readiness_gates_entire_native_graph(self):
        generator = select_generator()
        self.assertTrue(generator and shutil.which('busctl') and shutil.which('systemctl'))
        environment = {'PATH': os.environ['PATH'], 'PYTHONDONTWRITEBYTECODE':'1'}
        for key in ('XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS'):
            if key in os.environ: environment[key] = os.environ[key]
        prefix = 'quadlet-cold-' + uuid.uuid4().hex + '-'
        created = []
        with tempfile.TemporaryDirectory(prefix='quadlet-cold-') as temporary:
            root = Path(temporary)
            environment['HOME'] = str(root)
            rendered, generated = root/'rendered', root/'generated'
            subprocess.run(['bash',str(HERE/'render.sh'),str(rendered)], env=environment | {'DEPLOY_DIR':str(root),'API_IMAGE':'ghcr.io/pcugame/pcu-graduationproject-v2-api@sha256:'+'a'*64}, check=True, capture_output=True)
            generated.mkdir()
            result = generate(generator, rendered, generated, environment)
            self.assertEqual(result.returncode,0,'native generation failed; output withheld')
            assert_graph(self,generated)
            graph = {p.name:settings(p) for p in generated.glob('*.service')}
            names = {unit:prefix+unit for unit in graph}
            dummy = root/'dummy.py'
            dummy.write_text('import pathlib,sys,time\npathlib.Path(sys.argv[1]).write_text(str(time.monotonic()))\nwhile True: time.sleep(1)\n')
            probe = root/'probe.py'
            probe.write_text('''import importlib.util, pathlib, subprocess, sys, time
spec=importlib.util.spec_from_file_location('gate',sys.argv[1])
gate=importlib.util.module_from_spec(spec);spec.loader.exec_module(gate)
boot=float(pathlib.Path(sys.argv[2]).read_text())
def run(args, **kwargs):
    elapsed=time.monotonic()-boot
    if args[-1]=='default': answer='' if elapsed<7 else 'default fixture'
    elif args[-1]=='1.1.1.1': answer='fixture'
    else: answer='{"BackendState":"Starting"}' if elapsed<11 else '{"BackendState":"Running"}'
    return subprocess.CompletedProcess(args,0,answer,'')
ready=gate.wait_ready(run=run)
if ready: pathlib.Path(sys.argv[3]).write_text(str(time.monotonic()))
sys.exit(0 if ready else 1)
''')
            def properties(unit):
                values = [string_property('Type','exec'),string_property('StandardOutput','null'),string_property('StandardError','null')]
                for section,key,signature in (('Service','Restart','s'),('Service','RestartSec','t'),('Service','TimeoutStartSec','t'),('Unit','StartLimitIntervalSec','t'),('Unit','StartLimitBurst','u')):
                    value=graph[unit].get((section,key))
                    if value:
                        prop = {'RestartSec':'RestartUSec','TimeoutStartSec':'TimeoutStartUSec','StartLimitIntervalSec':'StartLimitIntervalUSec'}.get(key,key)
                        values.append([prop,signature,str(int(value[-1])*1000000) if signature=='t' else value[-1]])
                for key in ('Wants','Requires','BindsTo','PartOf','After','Before'):
                    peers=[names[p] for p in words(graph[unit],'Unit',key) if p in graph]
                    if peers: values.append([key,'as',str(len(peers)),*peers])
                if unit==POD:
                    values.append(exec_property('ExecStartPre',sys.executable,[sys.executable,str(probe),str(HERE/'wait-network-ready.py'),str(root/'boot'),str(root/'ready')]))
                values.append(exec_property('ExecStart',sys.executable,[sys.executable,str(dummy),str(root/(unit+'.started'))]))
                return [str(len(values)),*[item for value in values for item in value]]
            command = ['busctl','--user','call','org.freedesktop.systemd1','/org/freedesktop/systemd1','org.freedesktop.systemd1.Manager','StartTransientUnit','ssa(sv)a(sa(sv))',names[POD],'fail',*properties(POD),str(len(graph)-1)]
            for unit in graph:
                if unit!=POD: command += [names[unit],*properties(unit)]
            (root/'boot').write_text(str(time.monotonic()))
            created=list(names.values())
            try:
                result=subprocess.run(command,env=environment,capture_output=True,text=True,timeout=30)
                self.assertEqual(result.returncode,0,'auxiliary transient graph registration failed; output withheld')
                # Native network-online could already be active at this point.
                time.sleep(7)
                self.assertFalse((root/(POD+'.started')).exists())
                self.assertFalse(any((root/(unit+'.started')).exists() for unit in WORKLOADS))
                deadline=time.monotonic()+30
                while time.monotonic()<deadline and not all((root/(unit+'.started')).exists() for unit in (POD,*WORKLOADS)):
                    time.sleep(.1)
                self.assertTrue(all((root/(unit+'.started')).exists() for unit in (POD,*WORKLOADS)))
                boot=float((root/'boot').read_text())
                ready=float((root/'ready').read_text())
                self.assertGreaterEqual(ready-boot,20)
                for unit in (POD,*WORKLOADS):
                    self.assertGreaterEqual(float((root/(unit+'.started')).read_text()),ready)
                for unit in (POD,*WORKLOADS):
                    result=subprocess.run(['systemctl','--user','show',names[unit],'--property=NRestarts','--value'],env=environment,capture_output=True,text=True,timeout=30)
                    self.assertEqual(result.returncode,0)
                    self.assertEqual(result.stdout.strip(),'0',unit)
            finally:
                if created:
                    subprocess.run(['systemctl','--user','stop',*created],env=environment,capture_output=True,timeout=30)
                    subprocess.run(['systemctl','--user','reset-failed',*created],env=environment,capture_output=True,timeout=30)


if __name__=='__main__': unittest.main()
