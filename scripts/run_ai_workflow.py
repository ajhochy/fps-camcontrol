#!/usr/bin/env python3
"""Repository workflow adapter. No merges, releases, or implicit branch cleanup."""
import argparse
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parent.parent
CONTEXT = ['AGENTS.md'] + ['docs/ai/' + name + '.md' for name in
    ['project-state', 'repo-map', 'architecture', 'testing-guide', 'current-plan', 'decisions']]

def run(*args):
    return subprocess.run(args, cwd=ROOT, check=True)

def output(*args):
    return subprocess.check_output(args, cwd=ROOT, text=True).strip()

def identity():
    remote = output('git', 'remote', 'get-url', 'origin')
    branch = output('git', 'branch', '--show-current')
    print(remote, branch, sep='\n', flush=True)
    if remote not in ['https://github.com/ajhochy/fps-camcontrol.git', 'git@github.com:ajhochy/fps-camcontrol.git']:
        raise SystemExit('Refusing operation against an unexpected repository')
    if not branch or branch == 'main':
        raise SystemExit('A feature branch is required')
    return branch

def status():
    missing = [name for name in CONTEXT if not (ROOT / name).is_file()]
    print('Repo root:', ROOT)
    print('Missing context: ' + ', '.join(missing) if missing else 'Workflow context files: OK')
    return bool(missing)

def smoke_prompt():
    print('Build: pnpm electron:package\nPackaged smoke: pnpm test:electron:runtime')
    print('Runbook: docs/electron.md. Hardware and a fresh Mac require the operator drill.')

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('status')
    checks = sub.add_parser('checks')
    checks.add_argument('--level', choices=['issue', 'smoke', 'pr'], default='issue')
    pick = sub.add_parser('next-issue')
    pick.add_argument('--milestone')
    start = sub.add_parser('start-issue')
    start.add_argument('--issue', required=True, type=int)
    start.add_argument('--execute', action='store_true')
    pr = sub.add_parser('open-pr')
    pr.add_argument('--title', required=True)
    pr.add_argument('--base', default='main')
    pr.add_argument('--body-file')
    pr.add_argument('--execute', action='store_true')
    workflow = sub.add_parser('run')
    workflow.add_argument('request', nargs='?')
    workflow.add_argument('--issue')
    workflow.add_argument('--milestone')
    workflow.add_argument('--execute', action='store_true')
    workflow.add_argument('--after', choices=['planning', 'implementation', 'memory'])
    workflow.add_argument('--check-level', choices=['issue', 'smoke', 'pr'], default='issue')
    workflow.add_argument('--pr-title')
    sub.add_parser('smoke-prompt')
    args = parser.parse_args()
    if args.command == 'status':
        return status()
    if args.command == 'checks':
        run('node', 'scripts/checks.cjs', args.level)
    elif args.command == 'next-issue':
        command = ['gh', 'issue', 'list', '--state', 'open', '--limit', '100']
        if args.milestone:
            command += ['--milestone', args.milestone]
        run(*command)
    elif args.command == 'start-issue':
        # Delivery is explicitly stacked into two branches; never create one per slice.
        branch = identity()
        run('gh', 'issue', 'view', str(args.issue))
        print(f'Continue on {branch}; user-specified two-PR topology is retained.')
    elif args.command == 'open-pr':
        branch = identity()
        print(f'Draft PR: {branch} -> {args.base}: {args.title}')
        if args.execute:
            if not args.body_file or not pathlib.Path(args.body_file).is_file():
                raise SystemExit('Provide a reviewed --body-file and complete verification before opening a PR')
            run('gh', 'pr', 'create', '--draft', '--base', args.base, '--head', branch,
                '--title', args.title, '--body-file', args.body_file)
    elif args.command == 'smoke-prompt':
        smoke_prompt()
    elif args.command == 'run':
        if status():
            return 1
        if args.request:
            print('Request:', args.request)
        for number in (args.issue or '').split(','):
            if number:
                run('gh', 'issue', 'view', str(int(number)))
        print('Active delivery plan: docs/ai/current-plan.md')
        if args.execute and args.after == 'implementation':
            run('node', 'scripts/checks.cjs', args.check_level)
        elif args.after == 'memory':
            print('Use open-pr with reviewed title/body and the intended stack base after verification.')
    return 0

if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except subprocess.CalledProcessError as error:
        raise SystemExit(error.returncode)
