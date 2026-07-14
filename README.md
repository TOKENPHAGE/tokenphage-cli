# TokenPhage CLI

![CLI](https://img.shields.io/badge/CLI-Node.js%20ESM-5EEAD4?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-555?style=flat-square)

> 먹어치운 토큰, 이젠 README에 기록하세요!

Claude Code와 Codex의 토큰 사용량을 모아 GitHub README에 붙일 수 있는 배지로 만들어 줍니다.

---

## 📋 요구 사항

- **Node.js 20.17 이상**
- macOS 또는 Windows (자동 동기화 사용 시)
- GitHub 계정

## 🖼️ 이런 배지가 만들어져요

GitHub README(이미지를 붙일 수 있는 곳이면 어디든)에 아래 한 줄만 넣으면 됩니다. `kobenlys`를 본인 GitHub 아이디로 바꾸세요.

```markdown
[![TokenPhage](https://api.tokenphage.com/badge/kobenlys)](https://github.com/TOKENPHAGE/tokenphage-api)
```

**결과 ↓**

<table>
  <tr>
    <td align="center"><strong>gpu · dark</strong></td>
    <td align="center"><strong>claude · light</strong></td>
  </tr>
  <tr>
    <td align="center">
      <a href="https://github.com/TOKENPHAGE/tokenphage-api"><img src="https://api.tokenphage.com/badge/kobenlys?theme=gpu&amp;mode=dark" alt="TokenPhage gpu dark 배지"></a><br/>
      <code>https://api.tokenphage.com/badge/kobenlys?theme=gpu&amp;mode=dark</code>
    </td>
    <td align="center">
      <a href="https://github.com/TOKENPHAGE/tokenphage-api"><img src="https://api.tokenphage.com/badge/kobenlys?theme=claude&amp;mode=light" alt="TokenPhage claude light 배지"></a><br/>
      <code>https://api.tokenphage.com/badge/kobenlys?theme=claude&amp;mode=light</code>
    </td>
  </tr>
</table>

> 🎨 URL 뒤에 옵션을 붙일 수 있어요 — 테마 `?theme=gpu`(기본) 또는 `?theme=claude`, 색상 `?mode=light`(기본) 또는 `?mode=dark`.

## 📦 설치

```bash
npm install -g tokenphage@latest
```

설치 후 `tokenphage` 명령을 쓸 수 있습니다.

### ⬆️ 업데이트

대시보드를 열면 새 버전이 있는지 확인합니다. 새 버전이 확인되면 대시보드 맨 위에 안내 배너가 뜨고, 메뉴에 **⬆ Update to …** 항목이 추가됩니다. 이 항목을 고르면 최신 버전이 자동으로 설치됩니다(전역 설치가 아니면 정확한 수동 명령을 안내).

직접 올리고 싶다면 언제든 아래 명령을 실행하면 됩니다.

```bash
npm install -g tokenphage@latest
```

> 업데이트 알림을 끄려면 `TOKENPHAGE_NO_UPDATE_NOTIFIER=1` 환경 변수를 설정하세요.

## 🚀 빠른 시작

```bash
tokenphage                       # 대화형 화면 실행 (처음이면 로그인부터 안내)
tokenphage login <github-id>     # GitHub 계정 인증
tokenphage sync                  # 지금 사용량 동기화
tokenphage install-hook          # 매일 04:00 자동 동기화 켜기
```

---

## 💻 대화형 사용법

`tokenphage`를 그냥 실행하면 메뉴가 뜹니다. **↑/↓로 이동, Enter로 선택, Esc로 종료**합니다.

### 처음 실행 (로그인 전)
```
  ❯ Authenticate with Gist     ← 로그인 시작
    Exit
```
`Authenticate with Gist`를 고르면 인증을 진행하고, 끝나면 자동으로 첫 동기화까지 마친 뒤 대시보드로 들어갑니다.

### 대시보드 (로그인 후)
```
  Authenticated as @your-id
  Last sync: 2026-06-22
  Auto-sync enabled (daily 04:00)

  ❯ Sync now              ← 지금 동기화
    Disable auto-sync     ← (또는) Enable auto-sync
    Advanced settings
    Exit
```
- **⬆ Update to …** — 새 버전이 있을 때만 맨 위에 나타나며, 고르면 최신 버전으로 자동 업데이트
- **Sync now** — 지금 바로 동기화
- **Enable / Disable auto-sync** — 자동 동기화 켜기/끄기 (현재 상태에 맞춰 표시)
- **Advanced settings** — 데이터 초기화 등
- **Exit** — 종료

### Advanced settings
```
  ❯ Reset all data    ← 데이터 전체 초기화
    Back
```
**Reset all data**는 서버에 쌓인 토큰 데이터를 모두 지우고 처음부터 다시 동기화합니다. 되돌릴 수 없어서, 확인을 위해 **본인 GitHub 아이디를 직접 입력**해야 진행됩니다. (로컬 기록은 건드리지 않으며, 24시간에 한 번만 가능)

---

## 🔐 로그인 (Gist 인증)

비밀번호 없이, **본인 GitHub 계정으로 공개 Gist를 만들 수 있다는 점**으로 계정을 인증합니다.

1. 화면에 인증용 문자열이 표시됩니다.
2. 안내대로 `https://gist.github.com/new`에서 **공개(public) Gist**를 만듭니다.
   - 파일 이름: `tokenphage.txt`
   - 내용: 화면에 나온 인증 문자열
3. 만들어진 Gist의 주소(URL)나 ID를 붙여넣습니다.
4. 인증이 끝나면 로그인이 완료됩니다.

---

## ⌨️ 명령어

| 명령 | 하는 일 |
|------|---------|
| `tokenphage` | 대화형 화면(메뉴)을 엽니다. [대화형 사용법](#-대화형-사용법) 참고 |
| `tokenphage login [github-id]` | GitHub 계정을 인증하고 로그인합니다. 아이디를 함께 적으면 입력 단계를 건너뜁니다 |
| `tokenphage sync` | 지금 바로 토큰 사용량을 동기화합니다. 잠시 뒤 배지가 갱신됩니다 |
| `tokenphage install-hook` | 매일 자동으로 동기화되도록 설정합니다 (시간·상세는 자동 동기화 절 참고) |
| `tokenphage uninstall-hook` | 자동 동기화를 끕니다 |
| `tokenphage --version` | 버전을 봅니다 |
| `tokenphage --help` | 도움말을 봅니다 |

> `login`은 화면 입력이 필요해 일반 터미널에서 실행해야 합니다.

---

## ⏰ 자동 동기화

`install-hook`을 켜면 매일 **오전 4시**에 자동으로 동기화됩니다(macOS·Windows). 컴퓨터를 거의 안 쓰는 시간대라 작업을 방해하지 않습니다.

- 켜기: `tokenphage install-hook` (또는 대시보드 → Enable auto-sync)
- 끄기: `tokenphage uninstall-hook` (또는 대시보드 → Disable auto-sync)
- 실행 기록은 `~/.tokenphage/logs/sync.log`에서 볼 수 있습니다.

처음 설정할 때 권한을 묻는다면:
- **macOS** — 시스템 설정 → 개인정보 보호 및 보안 → 자동화 허용
- **Windows** — **관리자 권한 터미널**에서 다시 실행

---

## ⚙️ config.json 설정

로그인 정보와 설정은 `~/.tokenphage/config.json`에 저장됩니다. 여기에는 로그인 토큰(JWT), **기기 식별자(deviceId)**, 마지막 동기화 날짜, 자동 동기화 설정이 들어 있습니다.

> ⚠️ **이 폴더나 `config.json`을 임의로 지우지 마세요.** `deviceId`가 사라지면 아래처럼 토큰 집계에 노이즈가 생길 수 있습니다.

### 🗑️ 만약 지워졌다면 (노이즈가 생기는 이유)

`config.json`이 사라지면(폴더 삭제·재설치·다른 기기 등) 이런 일이 벌어집니다.

1. 로그인 토큰이 없어져 **다시 Gist 인증**을 해야 합니다.
2. 재인증하면 **새 `deviceId`가 발급**됩니다 (기존 것은 복구 불가).
3. 마지막 동기화 기록도 사라져, 다음 `sync`가 **전체 히스토리를 처음부터 다시 업로드**합니다.
4. 서버는 같은 사용량이라도 `deviceId`가 다르면 **별도 행으로 저장**하고, 배지의 누적 토큰은 **모든 `deviceId`를 합산**합니다. → 같은 기록이 옛 `deviceId` + 새 `deviceId`로 **이중 집계되어 누적 토큰이 실제보다 부풀려집니다.** (다른 PC에서 각각 동기화한 것과 같은 노이즈)

### ✅ 노이즈를 없애는 법 — 전체 초기화(Reset)

1. `tokenphage` 실행 → 필요하면 먼저 재로그인(Gist 인증) → **Advanced settings → Reset all data**
2. 확인을 위해 본인 GitHub 아이디를 입력하면, 서버에 쌓인 **내 토큰 사용량 전체(노이즈 포함)를 삭제**한 뒤 곧바로 처음부터 다시 동기화합니다.
3. 그 결과 **현재 기기(단일 `deviceId`) 기준의 깨끗한 누적치**로 복구됩니다.

> ℹ️ Reset은 **서버 데이터만** 지우며 로컬 Claude 기록은 건드리지 않습니다. 남용 방지를 위해 **24시간에 한 번**만 가능합니다.

---

## ⚠️ 유의사항

### 🧹 토큰이 누락되지 않게 하기

**Claude Code는 오래된 세션 기록(트랜스크립트)을 자동으로 삭제합니다.** 삭제된 기록의 토큰은 다시 집계할 수 없어, 그대로 두면 누적량에서 빠져 버립니다.

- 보존 기간은 Claude Code의 **`cleanupPeriodDays`** 설정으로 정해집니다. **따로 지정하지 않으면 기본 30일**이라, 30일이 지난 세션은 사라집니다.
- 그래서 **로그인 직후**(보존 기간이 넉넉하지 않을 때) CLI가 한 번 **"기록을 계속 보관할지"**를 물어봅니다.
- **Yes**를 고르면 `~/.claude/settings.json`의 `cleanupPeriodDays`를 **`99999`(사실상 영구)**로 바꿔, 이후 모든 토큰이 빠짐없이 집계됩니다. (이미 충분히 큰 값이면 그대로 둡니다)
- 설정 파일이 손상돼 있으면 **건드리지 않고**, 수동으로 넣는 방법을 안내합니다.

> 💡 **직접 설정하고 싶다면** `~/.claude/settings.json`에 아래 한 줄을 추가하세요.
>
> ```json
> { "cleanupPeriodDays": 99999 }
> ```
