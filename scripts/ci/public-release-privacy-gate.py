#!/usr/bin/env python3
"""Public release privacy gate for GitHub-hosted release workflows.

Internal hostnames are supplied through PUBLIC_RELEASE_FORBIDDEN_HOSTS so this
script can live in a public repository without exposing private infrastructure
names in source.

Note: This scanner operates as a best-effort blocklist and does not guarantee zero false negatives.

Coverage honesty: the embedded-string pass does NOT decompress generic
compressed containers (gzip/zip/tar), does not decode PNG IDAT image data, and
does not unpack other container or archive formats. A secret hidden inside such
a payload is invisible to content scanning. Binary safety rests on the
unreviewed-binary FAIL plus the reviewed hash-pin allowlist
(ALLOWED_BINARY_ARTIFACTS) and on the default-deny export pathset
(--allowlist-pathset), NOT on embedded-scan coverage. Do not oversell this
scanner as seeing inside compressed or binary containers.

This gate is the fail-closed authority. When --allowlist-pathset is supplied it
refuses any real path not covered by the export allowlist pathset before the
blocklist content scan runs (the scanner remains the content backstop).
"""

from __future__ import annotations

import argparse
import binascii
import base64
from bisect import bisect_right
from collections import Counter
from contextlib import contextmanager
import fnmatch
import hashlib
import json
import math
import os
import re
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, Iterable, Iterator


DEFAULT_EXCLUDES = (
    ".git/**",
    ".venv/**",
    "node_modules/**",
    "dist/**",
    "coverage/**",
)

PRIVATE_ROOT_DIRECTORIES = {
    ".claude",
    ".codex",
    ".scannerwork",
    "artifacts",
    "coverage",
    "data",
    "evidence",
    "handoffs",
    "keystore",
    "logs",
    "playwright-report",
    "screenshots",
    "test-results",
}

PRIVATE_ANYWHERE_DIRECTORIES = {
    ".claude",
    ".codex",
    ".scannerwork",
}

PRIVATE_FILE_NAMES = {
    ".app-secret",
    "initial-admin-password",
}

PRIVATE_FILE_PATTERNS = (
    "*.db",
    "*.db-shm",
    "*.db-wal",
    "*.har",
    "*.jks",
    "*.key",
    "*.keystore",
    "*.p12",
    "*.pem",
    "*.pfx",
    "*.sqlite",
    "*.sqlite3",
)

ALLOWED_PRIVATE_PATHS = {
    ".env.example",
    "data/.gitkeep",
}

ALLOWED_BINARY_ARTIFACTS = {
    "client/public/android-chrome-192x192.png": "f5ea1eb795796cc4306b3bedb38922bfa19541d3965a5eec2c877d60433786e6",
    "client/public/android-chrome-512x512.png": "f276ab53880f9711e1483ec37b4da8be36816f67787fff95b90fb1c5acc427ec",
    "client/public/apple-touch-icon.png": "49c9f5d6edb55d0f34e3165194dc98b335df09a4bb1427ae5691b999ed969a83",
    "client/public/favicon-16x16.png": "6327376bcf68b825016c3888eb2ab8fc3eb018160e45a2f62703f3e937c32cdc",
    "client/public/favicon-32x32.png": "d52df6c886e2ed20a777547f7651559fc8f62169b481d71dad214cbb750b323d",
    "client/public/favicon.ico": "88f7d3c44a8d10e825d8126a4e73d659715c8aa32036834ea2926f02c184c44d",
    "client/public/logo-256.png": "885e639e7c83c55d88c097360b191790716e85ba216e186563e7225aba5fbbd3",
}

# Frozen public history materials: exact original bytes, never new publication content.
# Source proof: history-privacy/reviewed-materials-primary-proof.json and image/crypto readbacks.
REVIEWED_PUBLIC_HISTORY = {
    "git_commit": 'e01da384e59b9fabbdb9182b4d5bba17d82afa53',
    "commits": [
        {'git_commit': '004aa5fd2071287e95f78ec40b7c5a6525e1d2cc', 'sha256': '4303643795deb5424a0a29341a2f3a5ae04a4ebafb9e164f79e099a9e59557fc'},
        {'git_commit': '00f3c8dbcb1255ab59f7f986fa0208f4d71ae716', 'sha256': '84aacb28d80f768fd3c80445618e2451b0ecca14998c4115ea9ab8a6b76bce9e'},
        {'git_commit': '01b13cd67dc7da897815d2fc388ddfb73ecb9341', 'sha256': '7cf889ab8b7026c6cf434025c449e4eb7e33b2a72ec71fe2c48ffb9682fce561'},
        {'git_commit': '024812ff86e92676126a46c6790252759d403915', 'sha256': '7033ce7e9f521acd917334a79ee7f30dba6a94eae29f85b7673693533ce8659b'},
        {'git_commit': '026dfa5da7e66f67de3a05ffea22ca69e400e5e7', 'sha256': '4cf0dbeaab5b19e9e768884369e14a369d4a9942b22efd1b33623793cbc5e6ba'},
        {'git_commit': '04f157b7e6e40176eb8b99e6f15a0ffaaef68229', 'sha256': 'a219fa4f3cef3570b2c1c27ff6d184222b69fc5fcfef46215137489d069c6ce8'},
        {'git_commit': '059657246ab7a656cc790d4ce51cedb5714a54cb', 'sha256': 'fa11b65b52d24fe7e0d6624ddbfd600a2e31a1730ab52b7e94bf3415b5699e4b'},
        {'git_commit': '0598e6b074b88a229f0e34dd1071bc7b11f53db7', 'sha256': '04c7ae327645a3afb6b767528dfedf70674cf29ddae107bb8bc7894db6adc726'},
        {'git_commit': '071b6bee97b0ce58fb94a95e5fe984690654eb08', 'sha256': '13cb86ae57f0c992f54d235b36167ed8f1802dabd8e526dddf2876f031d573a1'},
        {'git_commit': '072cbe055a00987727835c9fe650c9e8a7522175', 'sha256': '5bd2b9e154d2da69034cb10e39f1973960f20f8193a0126ca4442732090017e0'},
        {'git_commit': '083516ca4bf508cb29f1fcf4c4b8f6d1629eb689', 'sha256': '1f275d2aa049e56587c99fd3baaa9df5486f8a03848d5e47d2cb98fc96549ba1'},
        {'git_commit': '08cb263c7023ffd2de1a86fdce88253b3f762d4e', 'sha256': '2ffc5f4833bf48a7c971757b840f3a9c3feedd4430396fa4a905672bc7d66085'},
        {'git_commit': '094c8a89f1f02fd7ddbb9c86c95cb7d8087f6820', 'sha256': 'aff5a31bcd8afbd5799f397f1d202b6e4f2e9246399b8c927ddefa1c728c973f'},
        {'git_commit': '09a1d069f556e7978f30a817277dc0328ef87b03', 'sha256': '9bab897acdafb87dce1f760ec42e5daccce42fea6fb5d260c25bfac1660d8b93'},
        {'git_commit': '0a6b8e097b106d78ea9cdfbbd68cc6483f6d8bb6', 'sha256': 'ef138141fa09a14f6ac71b6b13b0d9135a8961dc9292c1872cf92140a09a449a'},
        {'git_commit': '0b82507cf2b946d16221e3182392714cf3fd2b14', 'sha256': '3d10d0b638ca1125bf2237c56f773d5ae05bbccc1f21ed63c935dad0956e03bf'},
        {'git_commit': '0bc0b6fdb55da85868fc7c025a55b7bf434ed54b', 'sha256': 'af1ce43842f5e12b785d6bd4c3722b9a6fde7e45c3543b1ac010e59bb8959b34'},
        {'git_commit': '0bc44b9c8e941bb9eacbe82e1ee1246545c6e4f6', 'sha256': 'dd3a30fe6611c378ed44ed94c2843ac76e3db69434dcf1df491df5b0660ef466'},
        {'git_commit': '0bfb4a470986d4539a1c89d03a4589d9b17e093b', 'sha256': '18c977b52cedf4feb4829d6d8147afb6df27ab8e725c6bea7426c6ccf0b37046'},
        {'git_commit': '0c29277dd234d9ef8006ba0a5d6827c294fd1941', 'sha256': '7ff1bc2cbaf0041431e746530ecb29ee4f2e2db90b7f974a05f41213f32da41f'},
        {'git_commit': '0e1a2b002a4eb91fc1db7b766e48bec78125ec81', 'sha256': 'f5ef4fe4e95039bf1f7bff4b747aee5f442c768c7f8fcad6b6db37466433a64c'},
        {'git_commit': '0e3ca6f15095552198fef84e50f33cb485b3dcf3', 'sha256': '7577e750b49b4a70e85a8be22fe7f413b8d8fe46d0b74b7dced8fa1a21d2b459'},
        {'git_commit': '0ee0fdc111bdad049861c64b2b2f59d521f9d5a2', 'sha256': '6cce5e2612e7e9dc5f2137d9c3d0d5dd2c04412df8979856816e089240e1b8c0'},
        {'git_commit': '0ee1861076f2f036ce0300cded4ebe4365c2a2de', 'sha256': 'c44d1304bfb8f93bead2105d95701d01976a01f6017e664fbd73e30af8facb9d'},
        {'git_commit': '0f126b48468c5652e073fcf9e3a8272d5fb92308', 'sha256': 'a02dd3cd6db1569b6470c3fb18011fcca230f27388b783b5335ec7344620c41f'},
        {'git_commit': '0f8233be6e340d2771a6d734d1a4f3b5abbf2cd0', 'sha256': '0f50b59a08610bf5a23649115b61367012872ab30fc22431b004ec69f13ce07b'},
        {'git_commit': '10588fa799f82b80b445e0197e6bfe2bfce0d87f', 'sha256': 'e4612da998cd1597b8dfc3ac46d18dd87811688bfc659c1717a1e0e5e859c163'},
        {'git_commit': '10e6cd09cc7e12e0422e377c3591605af41445fc', 'sha256': 'd36347bbf88b4f5345eacafee1d2d39b236f007430a4ed0cd6a75de13e05c991'},
        {'git_commit': '12573c96fe96b0c84a75eaa11e34154edfa4c7ed', 'sha256': '65fc4416ed26b00e4b51d4356d84cebda6582e9de70893bbc94c44919bddb834'},
        {'git_commit': '127cf7b8d65a4e913851f379d3353f1d18df2915', 'sha256': 'd7351d59bda1719081ce6f477d0d619a116c19998c84261a914a57b866db24fb'},
        {'git_commit': '1359a3da10e715f634b25ccd5f08f9affd1552bf', 'sha256': 'e7dec02470bfd07e5119bd09333bbaf5b74713b8da80b21a0159793432545590'},
        {'git_commit': '140adb40cc2abd10075c2cc074e72d12066d25f1', 'sha256': '1d440f6935e1e1376e4b868df81a2ca686fa5f5f9e07e7a2df75ad63460d84ac'},
        {'git_commit': '15b5fa77517d1f75c0317d3139ae9f68dca12291', 'sha256': '2a7c9e6a6cecf4d9856ce73c2d095c9b5ff659677d2e3854963f82f24306bc64'},
        {'git_commit': '15fa861ecbe89641a5efad2ab0fb9c236a3e9587', 'sha256': '6a9e7cee5ab12486ec9ec09cd22e98a450e505c2f1026b45205d34734277257c'},
        {'git_commit': '1714a8ca892381dcd5601e4aa20837f586654a8e', 'sha256': '7dd738ec875f0e89274c4e129dc579b067746568c79e2a808cf86097d8e9eeb2'},
        {'git_commit': '176410e5adab6db739481afeb3aa93ae3a111e58', 'sha256': '9634813f6cd2c880bb7afa74fb96c4ba3ab0bc514f59c5183c50138d5a7003c2'},
        {'git_commit': '179ce8c12e534311fa8fdd841130483a2aa016c9', 'sha256': 'f3bbb61e76997c84a507a0aea8913a4040f0fc3f257b3bc985871fe43b31e760'},
        {'git_commit': '18e5e6d7857d3e62f9fe23c5187aa5408d713bb2', 'sha256': '7da3bcee55ba14a0a7961909fe9d34aec7bfa9407b4626123fe866e3dde07510'},
        {'git_commit': '1a21a9b179c8a2603aa78a1de160dfdc74d41060', 'sha256': 'def19c3cbe580da4a4696c2610ab5d1bc9adea2759d02a3f1758cf6e03d2ff0f'},
        {'git_commit': '1ac20edd6de26e8d282fdef0543c1601001aafcf', 'sha256': '4b62d4ed282465258143a61f930fcbb4645e61e30d36816dfb689052dfc0bc24'},
        {'git_commit': '1c1695453b26ed55a273780ab1bffa403ab64216', 'sha256': '7de6f377f9464b5af962b89b51f7e54b995c4bd11f73c0881bfb6ea255c356b8'},
        {'git_commit': '1f738f82c2447371c5a7c8effae879d85edefbda', 'sha256': '577c7c9c88fc109b01314279a2276a318a685597c3d70999dd3e2aea1a1d6ec4'},
        {'git_commit': '1f8ce98f121b21c5d3872d5bbe37b324d40c4ff1', 'sha256': '4018786ea087c2bcdbe7c1c9c7e3e5928cfc8211836e8e4cff176b7895c579e7'},
        {'git_commit': '2303c8907d510bb358144bc2b70ada59b2bea8ab', 'sha256': '6c5bce16fcabb00e7d27fc40040f341afb8dfd4950de00b011f81b8bd75870f2'},
        {'git_commit': '23670e3c90f1aa4c716ca1722e644c62144e8fa1', 'sha256': '6362574edba93a61e1329ab9531ff1fca961a2f3fdf27909b20253390e65378d'},
        {'git_commit': '236db7d28c075466c51e7808ec59862524584362', 'sha256': '51139db6923998690b3d7a3f5f4495f7f307971dc6b8db44b1e99d5c53533ced'},
        {'git_commit': '23f952980983d9baaf687ade15b2dcc75bf23904', 'sha256': '48db224bae28cc1fcb1ebf0fc17cd082ed5857a2ced414b7edb3b20e0147d2d6'},
        {'git_commit': '247efa92fd39a8e9cb2fcab71f555ffc40a5af07', 'sha256': '9c988236e8e36cc259404c017b1928a3121e6e1268016a0cdd9b4ecd673bc37f'},
        {'git_commit': '24af923e74aeb510ff3104bb427fb4a0d36b4151', 'sha256': 'fdea34901257d5c545abc769d874b2fdf5aa206e8b97744ba039ffde608a1b03'},
        {'git_commit': '24c8877844fef9fa7f99e81aed617d605db77740', 'sha256': '38356fe9e78616189535295bfc9f9c6e21964be1a45766943535185dad3761d0'},
        {'git_commit': '2570afe292b03a4abb8033b6db3b4a8c50aacab8', 'sha256': 'ee769efd09e9e3c0b66182297100ad128588a71622f2fe5e65f8c6d261552bf5'},
        {'git_commit': '26c7af646cd8c7a356fdfb2e098c9ae71b9495ad', 'sha256': 'e74ae81a0e0d4963a50ddc52e27dac8a669cd149fc6178c68633688b3423a3ee'},
        {'git_commit': '27c3f71e0df80910e0b0b3ca85e3fadcc3fe57bd', 'sha256': 'a4054b41445d972e435334e91df6a2c4d08a0683017319f90f1938280bfbd3d3'},
        {'git_commit': '28879899c0452dde30a1117360781f7b0296061c', 'sha256': 'ed85798bc9043d73eb2098dec870edaf0dbc51cbd7b56da8f94e112c1e207086'},
        {'git_commit': '29e901737ad83272c58df71c3b2075af9100e6a9', 'sha256': 'eb12050b5d7679656294199142d483b1de1da595981002d43e9792fe37ca34aa'},
        {'git_commit': '29f999829445d3f062c1160917c758f28d55f0e1', 'sha256': '5b0ea9882300b365ec774b6140b512a180ff9e9df854f4bd0f507407d13149b0'},
        {'git_commit': '2b32fe9274b7b22413cd30e87bca2e024adbdf76', 'sha256': 'bb74a2a904f21a5081467d1e05cc928a493cdcee896ffd800f3dbf18a3537d33'},
        {'git_commit': '2d54e806d468fb2a25a1e0e385aa2c598d4d1893', 'sha256': 'b3cb6662aed7ffc6a755d2cb2909c4040b9c761113e4536c9edb44a96120d6bd'},
        {'git_commit': '2e138a1592151789d26dc8190f97289f897dd438', 'sha256': '84fc5be3982979ab1d6b90f0de987f01d4b30703135ddf25e90ba4de3ae2f43f'},
        {'git_commit': '2eb57f6a270a6d5ac54dc7769a4cc8ad15fc6494', 'sha256': '8d602104826bbe1f3425df946caf90fd6b1c4d64cf46e2e9698fc5668c82318c'},
        {'git_commit': '2f68adc6a9f92cf1eff38462bc4193975c02eebb', 'sha256': '9319e16b92815be887bae5c9e2cf69ffdbc824e4314642fcabbe1a27ab4d55e5'},
        {'git_commit': '300fb76171e5ef7ef31ee3466e9fa624a7d7af7c', 'sha256': '46e911185f0940389bccbdfc50c9340a0f4df4096420979a0f4e4f90e399604b'},
        {'git_commit': '30781d6ab044590db8e7a0c41358d94c60fb2167', 'sha256': '3930c5acf6283fb2a80bbba1e080b396f9cf154b52fc9625bc868cdfc39b89ad'},
        {'git_commit': '325ba74f432976dc7fc4d63dd91da109ad38c916', 'sha256': 'f5c2fa294a5c8e81dd224ae7ab3ca68957ae7a74eea81d22b0c211360c312815'},
        {'git_commit': '334c88065aa446e65d9fa1535b6649cae9e117dd', 'sha256': '33dda75ee5e48be88df72da5139345dd301948116965b247ae329dd238d93d03'},
        {'git_commit': '348d63f489d8ee78ad53adf23e05a0a9f69233f8', 'sha256': '70e7cc64e317958f39189f60d7c5052750743af9a88cb34de03b2666e59855ef'},
        {'git_commit': '34fb7fbe064ab00d2244d9a98194726c43c7b9ca', 'sha256': 'f0703a0ade462d1a06990c10434aab8ef65d080082912b2d9a1e8e74cb0bdff0'},
        {'git_commit': '354b2ea6d63a1f6ae155611549d8423b1b5f885d', 'sha256': '0de05ccff2116f10cf170cc92d6e78ffa1ee72f4006a421dd928bcedf0e820b8'},
        {'git_commit': '3596ae192fe9507023cb0cf7e67fb8d4a384ed1d', 'sha256': 'e5c3cc193eb3b9dd77fd506c0affa417efaebba7fa6a09005c054f2ea7320bbd'},
        {'git_commit': '35ceac20824bc7e080ca81a605a1ceca33a8096c', 'sha256': '574a8219650371aa0419c5e5091a2f2f48ae401785c1436cd041b4b55a6c1544'},
        {'git_commit': '36ce638d4f129941be489872080dcb746eeb2dee', 'sha256': '96a7dd9666efb055732708962d6664c869371866e8ecdb7ddaeedbf634e22e6a'},
        {'git_commit': '372af54e66acac45050da0bbf26e36ed62aa3731', 'sha256': '2d7c1258181fa8d574d900f24f535cbae6827301108d1363f9a6d64c3094d009'},
        {'git_commit': '3a82e3aef07c97ea946ae9438db1d1681ae3adf3', 'sha256': '732765ee159e5c37f400577f03f8128251774f7497d045790e3f5d4238a3a501'},
        {'git_commit': '3c9819f33bb44c4f116ad87f2b7a81f3bd7fb087', 'sha256': '2ffe0b06a8dfbfeba7a058266514e5a629a0fb054179b79af76b4fbf4ce0568e'},
        {'git_commit': '3f0da1ec4eff7cef620887212828508f84743dc3', 'sha256': 'f7473d4864803ed391418cdd252bdfa4a89dcea4fbbcaf557b5bd070c22e5ed1'},
        {'git_commit': '3f37c83c4280a06acb2b911e76155d933df63e0b', 'sha256': '3b65e7904475759cf21b5c7280f9bba6c415de458a0219674b64153b5c9f6cd7'},
        {'git_commit': '40bec92ad7947ed75c54f4bc94b8403789febac3', 'sha256': '7b99d19f311729d6173b051dbec5a1ba6e293a6482a15e38471c7e7cf89c6250'},
        {'git_commit': '40ce7904c536cdfab56878782dab1f0e732dea10', 'sha256': '56238b81a9432ef0b442b3611e8d8de9003ab985d3afe27ee6871891d11ee24c'},
        {'git_commit': '423cc3450b1ebab506ef93361da3c88101053f3d', 'sha256': '88c1c9b31fa57588d0827c111ae685c7bce329c4dd45b5d71b8f2a0b46d26583'},
        {'git_commit': '43944349f12046f2ac40369f28c3674d000e75c6', 'sha256': '01e8d81ba0f930ed8a72feba1ee1895999f18a08a2712bcb2d66f9eb1ac2a821'},
        {'git_commit': '450e606bb7085b40873a601f1d7375ba60a75b0a', 'sha256': '96c959c61ed328469dd1f1d262cc99df7815de86013bb8de7d1120a39009bb8b'},
        {'git_commit': '479c83932d9736e239792f97676ea55efbbf58dc', 'sha256': 'adb0273dcc0c5ed25feb55c656204b1496ac719d5b7761c4483d52ec42f57d95'},
        {'git_commit': '4900d58a6867f6c04c45885d7d3b6a997cc1a1e0', 'sha256': 'c4d2c20885a400dbcd9d2fadb53c75c59f5b22890d413a213a2daff258ea42e6'},
        {'git_commit': '4a388066878bbdaa3b5f27d1f18d49be2eecae44', 'sha256': '70734d7fe9b365d47d81a7d403f6d513c3430ebcf9d69eca699051b055754ee8'},
        {'git_commit': '4c4069badfa8372084d4a14716e6a200596eb1d4', 'sha256': 'a1081860e013efca50fae6ff7b448d7f433b6b85f37bd6d2fcd78c590857f1bc'},
        {'git_commit': '4ce033d659151df625b02f02111edf953485abfb', 'sha256': '6adab728f2e43cedcc239814c0fd53f33a68363556591dc40b24f54032356857'},
        {'git_commit': '4e4077e82d41a6b1fdb97ed8076f93f87cf0ede4', 'sha256': '9b16c6a732328e6e308da245de19279bddcee097d3d8eb4d54b8816c8e72cc48'},
        {'git_commit': '5030d344124c3566cdaceb84002a7b1b069c2da1', 'sha256': 'c40a81d518aec076273f3883a9a57f42c63c3764bc362503de30157e9a8e9baa'},
        {'git_commit': '5064a8e112409ee2ce2b8c9a3a55410709c1657a', 'sha256': 'f5ff21e1f716ff15b0fe71a96c66c75ed66d07e6a2082d6911e1433fc9ad37c4'},
        {'git_commit': '5092639251d489f9bffe51897c9f5b82ef0f614e', 'sha256': '8dc5200ea2aea82f7b67de19e2e9a1244575c8064693704f6043e1944bcc85af'},
        {'git_commit': '50d82dcfb6a2348a487c444c8da52a953c378d19', 'sha256': '3e9909f9e894676578b66dc751393cfc0fbfc8ab4d48d7dd81d15fcc00f8331c'},
        {'git_commit': '523e2184c61cece1c4405afacb0b6a0c907d94cc', 'sha256': '1d2789edbca491f56db1501edec621f92aa23b69d0d0f3ad7d2adf4044b985dc'},
        {'git_commit': '52d64e95d25f9f39b47d61c56f66cefb98d231e5', 'sha256': 'b2f1a49f5a228c853cbcd639ad66cf2aac63ee219581773c15e7ef1538228bf7'},
        {'git_commit': '56438090645f3297744b02f95a26e17c84a2f754', 'sha256': '776cf68d1058d141021d1d52e4691a24ebe8be3531b7bf0d6b2caf87f25ee9fc'},
        {'git_commit': '566ba831cda964e56786807d9bf0457985736a21', 'sha256': '8ab12a8a8cef1eac462fce81f722c9b5b0c2a6bd4898ff232476d8daf8f5c4e7'},
        {'git_commit': '56963697c852d6b0c7c7b3311b3c88eca37e56b6', 'sha256': 'cdc603d37000f843a70cdc4074f4d2488eaf5af2ad81b4bfd230416acda5284c'},
        {'git_commit': '570f9429ffca905608f9832889e36697d57ca65a', 'sha256': 'e1a7261bc785a733978d7e804b0df6276534b9a7b006e1f09587eaee19e0b570'},
        {'git_commit': '5823e2a86cd390e64cd1b77dfe495e243874913e', 'sha256': '8950cf6ce7766c413ad914bfeee622218c22c7261a8edbf89a7dbf08f98dc919'},
        {'git_commit': '587b0b8dd5de7fd4eb6752853bdb7f888567ad7c', 'sha256': 'a57df51e073eddff21b0c55b27962c632abbbb39d0d0a22d30a315ce5a9358b7'},
        {'git_commit': '5d28b6c5899b3548abb73e6230adbd27a2b8e610', 'sha256': '41b963389ef7fbc3c2c3931d320194eb891db501eb322035aed34be77f5c7c27'},
        {'git_commit': '5dd7fe6c24c81aea6f36fdcc0c4d2a2149532a9c', 'sha256': '27bfad280f188da6f5f5381bbce0508c2932419f79182f379cfffa552b5ae890'},
        {'git_commit': '5e0b6c28f48d1a354b6d814e3c8fc6523f505282', 'sha256': '8c8b5979d9da8cced894f77feeb7dddb276b324811fe1a1c2db6a9b4d98de37e'},
        {'git_commit': '5e3bf760793d9076b4873b4d8590a2e678f1cb6f', 'sha256': '2580766e8b328f2d2008b7f3ef74b9da57b2e0f562719fa7879282982e929bcd'},
        {'git_commit': '5e4b650181db13ea3bd08a8dd9daf3645a262488', 'sha256': '0dfc1c605b8df21864c2d1cdaccb946a8da9046c1f777040971a32bd1252e61b'},
        {'git_commit': '5ea824edf0ec7dfad338df8296b9577b93e81a1b', 'sha256': '5104e01ce59b95f299d2425e86e50b29797f4ce31daceebe1e235d21d4103a23'},
        {'git_commit': '5ef2a8803e126bcf6f3346f4fdb4af57e5aa86b3', 'sha256': 'f3b883adba37935de8966b70d4e8818867a411a9af34de62f06fae84e863e141'},
        {'git_commit': '5f10776a094270b76c3dcbb827da7e3e0a57179b', 'sha256': '3b5a877a6fc5ea4cb3c802e54ae3ca72d67759075fa62250de6f556fef2e2d58'},
        {'git_commit': '5f1109b6bba7e55f6712028dfe37f8d347929567', 'sha256': '7aa43b34232dae8e41f927b12fc2f4086648e1ad0216b9202fb489b114734e65'},
        {'git_commit': '5f423cba0c8fd62d2926ed9b62246aa131ac581a', 'sha256': 'dc506bf29e8ff450117318db37b35f43c16204377990a870d84533bc1869e324'},
        {'git_commit': '608a8d634a89ad370b2ddd82972622ea8769e3d2', 'sha256': 'acb56273fb0a530de4cd26edf2b5184af6ba56fdb13ff8c939d1354d83baaf70'},
        {'git_commit': '6250cd0e7aa45efe183731def9b7f68dd1127b78', 'sha256': 'c6aaeb22a3bfa173e61aa72e1d8ac3db155dff0ae427333617c3baffbaaadfc3'},
        {'git_commit': '62a9e200edf4af79f232236f9a2ab22ff155c56d', 'sha256': '681cc6d88ec36178bf1d80bacadea929326299e2b3d9532932843edd688c9f57'},
        {'git_commit': '63c6fdd4f1c1adf904f0173901f997dd07324c4a', 'sha256': 'c9a956ba61de7b72224c4d1f7d8f908fdbc8ff78983a3cf1f32a20a87ff6e6cb'},
        {'git_commit': '657a1d36f66adb0aafc6a738ac874e0e32872d0e', 'sha256': 'add9c7ecb310ed62140355c0459458b5f82f021d6ff67028504d4ec4a6cc1bf2'},
        {'git_commit': '65b30dc19f9ca0a1285f363f9fbbb0f6d09bdbd8', 'sha256': '0c09f88cab810a5024bdbfc83429de3656957cede5cb5238e0a55decf33b3013'},
        {'git_commit': '65c7d22a76a98a072e10055fa93c49a2fb2aa99d', 'sha256': '95107fc082b2cfaf7c44d63d8668d413faa6edc705192c97358a225a2e24ce71'},
        {'git_commit': '6784a6e39f0d772ef834e99cc1b278bc84268f61', 'sha256': '0fc6737b0c8449810b78d962d6caf8fb189105f9be07e53a1c36568aaf51a282'},
        {'git_commit': '682c4d6f45e5506164bd9cfb97c30016f02b8db9', 'sha256': '24b87ca4ba8e2bba278162283f4ec09796ac5b13cea4073b1b129d29f20e70a8'},
        {'git_commit': '68ead643bcd8b5bf77b71bfcf9760d54ca27fecb', 'sha256': '4f433bc4606c527fdf2529e2147dca075265433e27ba6eff7e0be404f61f0221'},
        {'git_commit': '6924f271724defb12ce6b4d1526585c1b928928e', 'sha256': '3242332d5ab75a143e4d887bdfcba5e53c45e8f1a29740a38988ea826768d107'},
        {'git_commit': '6929886ab74d758cba365804dbdaca10e5628b42', 'sha256': 'e1520c59aeaa8d7fdb3eb04799b7b5aa3e3c6b45704ca44cdaae1375f3ed0ef7'},
        {'git_commit': '6aa8bd835a3827ff42174fe976d5dbd8abe6b1b3', 'sha256': '397e738285252d27348d1d9bbfc622fcda88032f5ff5a52569d376cb6cd3cf1a'},
        {'git_commit': '6b38985e35177647ea9c2b3b27f297451460a55f', 'sha256': '01a26f13637095f525b60d59837c32aa79b173c82c6f1b7edb9f716c59082f49'},
        {'git_commit': '6befd535c8317b8d52f382dc7b4f2f78ffd0cc3a', 'sha256': '067e86815f49a317d50be6b8e8bf9a97754583c72bbdfee40c948fb6ef6f1f35'},
        {'git_commit': '6bf8e026c7df7220768c7c22a75bf249c1d24409', 'sha256': '444882324e78d8ca0ecffcaf2f2c3105ff00ce7b6a8b959006f710b0f5a500c6'},
        {'git_commit': '6c485491007426891867f12081f8c3a249bfced0', 'sha256': '683dabecd6e192243f13190ba9e80d75e12b801fa0353bc956c7bede8923e9af'},
        {'git_commit': '6c9c954389d94421fb1c27b7e22e97e8f3c630b2', 'sha256': 'caecea1ff183331ef0404a24fb82fd79e7a9100720036789f1dc8d233390045a'},
        {'git_commit': '6cde4f059cd31b041c61b22ed5e384fcb2186458', 'sha256': '8ce464c29ec9d5c29a6d3b54f1afa18df600f6ec0884611b0383e6e42cab900c'},
        {'git_commit': '6d380a455d35877b8c6e443d53478a2d68d7d345', 'sha256': '10b8ec257644f017c52c13678faac15338685a33d0bb73cfee15d56f56d1f304'},
        {'git_commit': '6d56ed1b23d9185f209ea5e1df8f05ca0435e5cb', 'sha256': 'c0ac861e70bba40d0102440a4297e7847b35a3942e580d1b793a847b0f1e87bd'},
        {'git_commit': '6d8280b474fd346eb87b9454c105e43b7a080f6a', 'sha256': 'c8550baf1d57791f1cd9437f634a995f66b083d050d25917539b3ac4d245de52'},
        {'git_commit': '6ec1d89bb63b5835fcd0caf7c1d4d7e8aac4208c', 'sha256': 'b1c52ee395c82716f9edb3aa47287667ef81dbc96b86ae74190ee90cd6b622d8'},
        {'git_commit': '706fd390510aa2cf060fe1b867bf4e57dec72007', 'sha256': 'a64a88e9bfc5584bcf982f0e92aad92ec2463c22bbe316a94cd4516e1ea7e887'},
        {'git_commit': '7147bef8be36fe478938c42f1e7ad27b4523d8b9', 'sha256': 'bc7fbfdd97b64bf5e43400bdba8f84e5983027f6f6b58a7be0f0f04fe95d33f8'},
        {'git_commit': '715acdada5e010f0875cf44a9e12c72ed1ee2ddc', 'sha256': 'f8b39f75cc98c94d78797337e9bbe0aa04f7bb7019f1d321a5db8b5f0a541270'},
        {'git_commit': '730de7864f14dd4191faa905608c3850d1d824ca', 'sha256': '2801bff744d9be2621d54b74236d183ff58baf16a3c343f057f5a40448c7bdc0'},
        {'git_commit': '7515ff1c2502add0b83362580dea952ff50088ce', 'sha256': '8b846c37ae254031493e97af7d55ba0bb39ee1b460a6ae541205c514faa21936'},
        {'git_commit': '7572df83a2fa7ee7e879b84224baf685df7918df', 'sha256': '10c35fc8152b8b0dace546b4196458a03024b8b0298e901bb5dba529c8b71b60'},
        {'git_commit': '794ce05e3399185574ab01553e42bcd6b6cffdf1', 'sha256': '07a50a2871ebca8453e944a4e2f4175a6333d1cc80b93896ae4275fc56fdf5d0'},
        {'git_commit': '7af25fc0302c9f62995771449345fa740c7221f6', 'sha256': 'fc23c298e3655938a9f7b2621581d487af15cbe872996b19a8f1cf4a694e8ec1'},
        {'git_commit': '7b62025024103161ff3ac258cc1cd0347e55a225', 'sha256': '4e4ef263196656d63c41bb0592310dfde7e0cff8dc87a8726381953162803f45'},
        {'git_commit': '7db34df1f9a73e4ff0e137b342d0f07fa32065b1', 'sha256': 'cfa22656112bc2ccea11aad648660bfa9c72de179b8064b2cf77e2f79fac50f3'},
        {'git_commit': '7e7676f9d1c7b9527293518538b33be90374beae', 'sha256': '44888911a753296ebd96629a97e914fcc45907e0f4ece18d4a28ddbd7b3fbe33'},
        {'git_commit': '7f1f5e005208b593f11f2c9cc035d39fe35b02fb', 'sha256': '181b0fcbca756cc058b7a87a63dbce6e5d35852bccc6de667e7754752716d21c'},
        {'git_commit': '7f2c74a1da020965d702941a0366cbf5016429cc', 'sha256': '645506de26ac394ed3dc4c305f332570361542bac767ae6e23c5d8a2c33c3b2c'},
        {'git_commit': '803d8a2dee1da6b07a7ab17191dc775cf44a0b60', 'sha256': '3cd9f17c0cc204b70bc44c7d3d7c360f4a422e76248b37f1047acf532bd64b37'},
        {'git_commit': '80c94fcccf43164d321d26b34d840474840d604d', 'sha256': 'edcf52663d03406e7875abc8536ae01b4632bb79e358983db6c487138c604c46'},
        {'git_commit': '80c9d757591cc26931f3c3a60d80365eed68060f', 'sha256': 'd9425fd71b4c8020186dd1b7f56568773fe78016f9f15eb4e8aeb2f6fec4f7e3'},
        {'git_commit': '8189732af7c1bddb698e7a549e4b57737268f919', 'sha256': 'e2bedc9381636360b00d05fc35d42e867d4a6f3727062769cf854e28c1af8ed6'},
        {'git_commit': '81a55d1f886ac7d6cbb91936436561018aaca17b', 'sha256': '8d1a85f8a217c305208e4dcaab21edeac6ab664efde8908091a819d9944e8631'},
        {'git_commit': '826e76cce5735a2a2ca2634c5d37f198017572f5', 'sha256': '30b4c8791b746c7bc65b6fe3626ed8a758ac3022713e5fb8098da33b38753288'},
        {'git_commit': '82f1489b0626aa85eb7b7c773da397be8f6e7f8a', 'sha256': 'feb2aa009699cc824ba268e98b84a228be6d03d342806f0fa25db4ba6ebf693a'},
        {'git_commit': '84b66fde30322e58452f84a5d91c93823e764297', 'sha256': '76288ee390919bf7d9fdfe16e7b933c1c56871f8f212ab5d740a349f4c2e81a3'},
        {'git_commit': '860449a198f2287ac28cb9d1c1f573a2f6e26548', 'sha256': '19d82f032f6a7276bca24c2e95c1c9a0a77b71bc48d5fa82b81ca04321654bef'},
        {'git_commit': '86e9eb9d082aa7b45178beeab2910bf777ed6bf0', 'sha256': '7cdb8b09720961f1d08f1c043eed325fc16cc377c5732de1a9c2821f0d774d72'},
        {'git_commit': '88253380d490ddceefcd979928a086c6c1786d7f', 'sha256': 'f79ad6d804aba23e51e49e316951368552b6bff7fd8c9d0b2ceb5fc806589bcc'},
        {'git_commit': '89578acb03755d8f41e91d457e1a07694ed6581d', 'sha256': '8ca9d76a42bc0f15741f7db64ef55441c49c1258d0004579caa175ba1e80bf29'},
        {'git_commit': '895b5ce90f05bad8ef2b8be0497e9b28a42773ea', 'sha256': 'c9cc674008ab4553bb9ef648f5fa65cbcbc742c5e6f0e535bd5506108e330ea4'},
        {'git_commit': '8ab3241f731279e9dd61f9eb746f74b6bd84b5bc', 'sha256': '72ee63a239a80d4a268269650e70167a5b5f48ce560d31cbf14bbee0c81f2bb7'},
        {'git_commit': '8cd8113cafe0e6a74547c1c3d1bb1e8054359e68', 'sha256': '1b9d0546d84da52265f6865dfcbdd29f64640e0c5e3dfb8af1a60f68e1f7d199'},
        {'git_commit': '8d2ce0aed9286db3b4be45196959f7d749a09319', 'sha256': '2c33fd885d57c8b5295e921e8c5bf0ae6afe8a53c6d96309f21594b49b07504c'},
        {'git_commit': '8d53ec49c7bc29b947e1a0cf3b76bc4315a949fe', 'sha256': 'f88e912ae39bc00869c80b24899ecae9e3e4739fef936774de93332aec728915'},
        {'git_commit': '8df44fbc3c600debadfba31b7b7eec9a538197b3', 'sha256': 'c4b8190ca1c8cf65d89e341a1edd06f654d708437e2ebeff46e31a389037fde8'},
        {'git_commit': '8e0bff58e7f33c232e99f193f6eab9716fd41f5f', 'sha256': '1c74a1725e326ca04b89db1708461088acc80f36f461745ac1c4f3b68b6804c4'},
        {'git_commit': '8e14bfc3025b30a0eac8c60ad12625ece150b413', 'sha256': '429ef6609f06bc1b5cb536868d43d56f9983314a8cf333fc4792582d88307952'},
        {'git_commit': '8e682a51cbd85fefc0aa53f37c875ce8f7093b14', 'sha256': '995cd01f1ebce4260db2de7ca9dd795a544f1f2ccc726a8ed49101eb56e90a2a'},
        {'git_commit': '8f55374774b3aa9d8597fb444b8c645280a3cf1c', 'sha256': '241bcc875495e874895e15062d5b8448acf2ee3a53eb227cc532f313da0fff8c'},
        {'git_commit': '8ff57aa3204aa0b14de253b9ff2121caab9143c6', 'sha256': 'e98895ad749fc3d96b045b25df2e33f01c8f22231758408fcc77d9825cdd0a67'},
        {'git_commit': '9352fc2f00f63b6ea6137ed08593e195491cac4e', 'sha256': '9bd9763ac767b8fab12461b8b4b14ee50753ec61406ea645390319cbd6160f85'},
        {'git_commit': '93ac8e96ac59a2d700e70030de79fd20cf65c758', 'sha256': '9a7335e8e67d7e41565f2bab2a9d4f8b0b0c329b47e87b4e7cd686a2cc75fb22'},
        {'git_commit': '955cad96a262defa4c569c54613fd3a7309aeee5', 'sha256': 'a79b0b85c3981458308eb26988460efe4aad8eba2d111ce3bdee39f2be666f16'},
        {'git_commit': '95fff2f674c945d1200b0a162ada720ca586301f', 'sha256': 'ebccf629697e47184d93b45f0596b4972970d19ae815bef0b9e2d11e08693c1d'},
        {'git_commit': '960408c1b5960251c9cdb4fb9b977d32a62beb5c', 'sha256': '73391668cbbf8d072ac851bc5ee077a6c2f52e3519ca56a92a66beb22e8fbfdb'},
        {'git_commit': '9749d64fe7e5b032e9b9bcf578ceb820e52c57b4', 'sha256': 'b7f90a32d92191afe5a3ea17740140c8718f361d1a3dd3b51a48b0c326976241'},
        {'git_commit': '978c39bab0a826093bd0fd91feaacbf389e69bf6', 'sha256': '4ce10ec42b88c12edfd6136a9e5729c283111d0aa17b53535561914647147a98'},
        {'git_commit': '98d5412717264845c1831967dd23b06a92d64a10', 'sha256': 'b0b75e7e0878922999e6ab746a58079b5b69c28903d317fd9d7b48cd4741e985'},
        {'git_commit': '993c28b3f72a70f4ede50a46aaa6945cbbe5d5c3', 'sha256': '4f97c700ee47bcf987f2925183805b759c4fb6efef54d2318ca8037d90e911d9'},
        {'git_commit': '9a6ad705f46ee5e7df344b00dabc60320c1d774a', 'sha256': 'ae21be89b8c05e0000c82fdb6112666c671aa4f8088dc91bac121dd36f63ff51'},
        {'git_commit': '9aeba65265302bb228956efb3e794825904a58d3', 'sha256': 'd3f3162d516a3909428cf9b10f8f90f03529b0e0dbe1d0044e9f64259372a3c8'},
        {'git_commit': '9aee991c20d7190f5058945ee481015f9cfda134', 'sha256': '42489c472542db248bc84902a02830dccff760430919b1be88af364a27849760'},
        {'git_commit': '9c160fa042666f6e1ac2a6d39e4502dcadd20749', 'sha256': 'c1b91ccaab43b72dbe582371158cd265b8aac7844f428051e922c7f6c6649c23'},
        {'git_commit': '9d490bdb8b1ec095f16f032c313c98181373ceb3', 'sha256': '813127517c2d36ed218a23106b345bf4db3bda045080529573ceffd240bc018d'},
        {'git_commit': '9e7ff57139302dabf369f37bcb0352bcda81db78', 'sha256': '5b70708884e4034eab0878d399e798635fed29e61b68898ae4104ea2790292bc'},
        {'git_commit': '9efc270b8e3b4acb1744d517045b51d7b2aafb4b', 'sha256': '26fa69a5192a7a863b483f40aa5502ea66acdab39c0945e80637cabf47ad2a0f'},
        {'git_commit': '9f904e4c306b6e621a8df9b3fa04b12e4a831714', 'sha256': 'ce21d760aaa252188c4b66124361e3280b81a7bfd532c07cf1cf84eac3909af0'},
        {'git_commit': 'a00265ec726e96ccc50e21e0aaea143cacb7826b', 'sha256': 'a6608ee523bfc7eed9419c0fca974688605c00f87c9c6743bf3c63caa8eb3c87'},
        {'git_commit': 'a138fb73ab712a6f8920644b8c3deb046cf8a6c1', 'sha256': '8fc65f55bc1201b1be726dcaf116fcf717bd58dd7b0caa633fa3c2ea9c248ba5'},
        {'git_commit': 'a2e99d91307f4f7c0742034adb8042f8221b6e36', 'sha256': '424b50ecddde4a9fb23b677c8e3bbdc575dc2cca4e1a772801c8aa7eeae7620d'},
        {'git_commit': 'a2ef14c9b037a3d0c2b09f7b56c1f2787c830970', 'sha256': '519da5d58b095dcf40be276a4fc7fa360cbda421703dcbbfb81559103ab0c84d'},
        {'git_commit': 'a38b508b7039ea6ea9e4bdab8258b445274c4613', 'sha256': 'a7a053c2dc0975f9105f9497a4ec2bd69b2b61e13034d88c87b3981be071abda'},
        {'git_commit': 'a4a53f9af3e7662b9f0a3cbc2b78e9f5ca230ca8', 'sha256': '699813d03dd9400ad0699a3140897b57ef7dfe6e9aa71b129ed1548a8ff122e5'},
        {'git_commit': 'a4af63384c670c94505783606e6037ef6a1dd99e', 'sha256': 'f881c51fb8f0cd0984ab4981b9d9839ca9bd84c852fe886d7457fd92bec4e319'},
        {'git_commit': 'a5167986575fe7e971723a415e27a4c62974301f', 'sha256': '7c53546d35132ad21e4ca1d9ce19260c29b1bf1ff51e98c3fdf35dd525fc9799'},
        {'git_commit': 'a752a7084d75155268ee5da4ee27dedb1761440a', 'sha256': 'b51058e52f761ff842d97cf6e7bb908acc4369560c40f030ffb58b2383acf91a'},
        {'git_commit': 'a84125453a22ae5f75486e6435571c0d3c3f6194', 'sha256': 'b60b4d906735a1a5d983c4fd4c7b8e4054dbbe57a185b2e0e2a7f1effc09a264'},
        {'git_commit': 'a9beb32c3a68834e01bf0d60e84a242676e4eb3a', 'sha256': 'd2b063a87af6bebbb7498af26a789688f95828ef765e66754bf89e1b723ea9c9'},
        {'git_commit': 'aab412d402f9669bfe509b46b75e7eb81178a308', 'sha256': '6a7df93691c315a8cd62f8c0666d08e3e2d0300540a9590dc40079bdebfa0261'},
        {'git_commit': 'aca1ab6fb232a74d7a22df6e238025e7af84dfba', 'sha256': '6816497d30153d2557e79b2a48bedd6d29c32a0917b4c2f46af27c2c70f8f8a0'},
        {'git_commit': 'ad6864646b58285164e513746ed216900a8c079d', 'sha256': '6316bf6f7603e25eb419b6e8722a0c0db7c217f4a93ab197a938ccb877099ec0'},
        {'git_commit': 'ad6fdf7ea6f2633682438ec4197e5820ae63a5e4', 'sha256': 'e41ec08a1d12c3eb46eb853e0f67455269a437c678f52394d199703364c004bf'},
        {'git_commit': 'aff72ef1258620978f1d52f6f726b63f48a4e5d1', 'sha256': '88b538da760a48724503d51fcfc5e7125bdeeb37f04a8bd241ef08659e61ff04'},
        {'git_commit': 'b08dc2af33b062aec6a5cdfaba804e064b80885a', 'sha256': 'cb465128499bee7f9199da1909d0301c16e44e51a85b9e51ad5e34e0fe1c0ec3'},
        {'git_commit': 'b0caac9dfb8e3eaea69e481567435290cb959540', 'sha256': '2b511cf33f45e0a3a90e2b5a8741c8f2de903aaf6caad30fb92fbc76a18c65cf'},
        {'git_commit': 'b15012438839e4d65bb99855ddd6cc3c7c6f9b82', 'sha256': 'debe64287147f5e671fb9b764075bd61b8566e9ee4fe3df7d2ca07b9eb2b061b'},
        {'git_commit': 'b163ad6aebba5a2255a1f532f84e30809267d7f3', 'sha256': '0a67a2dc6f1a041490385c9bb3d0a7abc7cd5e4bad66d5e4b149b1d557d06a84'},
        {'git_commit': 'b24d335b7febf278eabccb3c84d4fb21cda5a1ff', 'sha256': 'dc9a3cc6fddfcc0cd0ddd482ff8f7cb10743611e6cdfcb41396f061d55121b45'},
        {'git_commit': 'b29904cef57f2bbdd730f0017b44e934f3546465', 'sha256': '1aa57b28887594b94504962686c677759549444bf4ad8d7c89cbe4d75b7fd84c'},
        {'git_commit': 'b2d7b089aaa1bcfd07f0a463d828a9bcefb67e3d', 'sha256': '70163a666f8ee0196fb1c996aac40fa5107653b431800ffc63938e2eef7e23d8'},
        {'git_commit': 'b594b1497a14b00be19210e5ba2147a2e48bbedd', 'sha256': 'a77f124ae97069792ca60857d4e603ef3225285a8ae5763c42eea8acfe74211e'},
        {'git_commit': 'b61d41e66e35f7dc9dc5f9408d8f5ce2d1f74258', 'sha256': '58a15ff77e2c3a2badcb880c0ee0f1d0a34826747f513fcb56e9a71ef7312010'},
        {'git_commit': 'b62127e7b18962f277c9a54bb6a41b3d403aff9b', 'sha256': '9987d19510d1f47eff5f8168e4644b34db4c558df9752fa9a3ae036b38b03730'},
        {'git_commit': 'b76fa8b2b15343a43d07cb9e6378f69ef984ca11', 'sha256': '85a3f0f01928fd812bdbd21f19a84024ba755cc8a979f6acee0f04ed343a5734'},
        {'git_commit': 'b8df292a04d5672ac58db9487722c4ac5e7632f6', 'sha256': '3519c2226401937a237be912da3ccf4b8af7dab9a749212fe2c12435dda81f4c'},
        {'git_commit': 'b991ad7af4194445c1e384c629d274ffdb5e49df', 'sha256': 'c77a821987a3974ef02fff9cfe6cd0ab8c187138fe43d4d6a375bba187a08f44'},
        {'git_commit': 'be44968bc18ced3b5e839e48dcfafaa36da10b1e', 'sha256': '9c0998165515664b76bc4f4578c62d03b409b7148b20bd45b4e98bf049a89911'},
        {'git_commit': 'bf3bdae1fef41c2118a24d7d1ac0edd502d22348', 'sha256': '8fb69f732c8ec357ba39ee849fd5fa6f2dc7a6f34757a41ccbcd8b28872c22fe'},
        {'git_commit': 'bf7b9f29a0e022c7a3e0ccc27103bc2a1ca24c94', 'sha256': '6ef8744223b7895b179f0673922a73d495d1d8087f9d062276af7a51ec2f0caf'},
        {'git_commit': 'c0f0cfc76aed757c9970a012f0e573bc7fa48f77', 'sha256': 'c39c41bde0218e53bd1c403daba1e21cd76ab3ec406bce88c9c393283cf5f63e'},
        {'git_commit': 'c38ba975b7cc548d41be28db5610375255914e5a', 'sha256': '759d97c00cd9e452d0c61255c8ce8a66b59eba31470c0cb1e59ad07174b7b369'},
        {'git_commit': 'c4a16602b4128918df89e9370a50bb7c5b715e2e', 'sha256': '5d796532d86afc22f9e10ec5fe605be06042fbf0521644c7183354aacd6d45c4'},
        {'git_commit': 'c4bb7b72a170c47721ce7f71567ce3b6ea0aa68e', 'sha256': 'b3c760299d6a18e99184158077efa8dbd7e6727b8918dfcdeda8358813dccd09'},
        {'git_commit': 'c5b89f7ff01ef3318f09500ea9c5e880b1a1c21b', 'sha256': 'bd0587406d1e22b4128d74a0c66a60d50161f814cf832a04b3e0c1ac16fbcf01'},
        {'git_commit': 'c69e863e7a74bb7bff9a4e37ada16c036834e7d4', 'sha256': '45eb0ef90d51a665692537ac1b6ada6b8d2331e3f1d746095ee44b5c972661ff'},
        {'git_commit': 'c8eefa53bc9c773ca24ac73ac7d5de5bd6afbb47', 'sha256': '1f628642d3a52f76146c1d6c1188393074ac126ac969a4599df9d9b03c2b39ca'},
        {'git_commit': 'c960b7bfcf3516d8fdeddf20cadacb36d52fe8d3', 'sha256': 'cd5a50170cd04f6883609fcb716173cf62d69daa03b93823f82007bf42259682'},
        {'git_commit': 'ca66d1f3eebb5f784aab5f4c1d0eee69a8438ccd', 'sha256': 'a4e2303bb451fff0bb3180584cf7cc977fa191b6c5582c35163a9a501e9729f0'},
        {'git_commit': 'cbe96091cb96f3b886b2fa24bdad9a9bc121ec08', 'sha256': 'd7f0a921dc50dbb4b04e10f5393fa1f1b74b661db7264b24cedfbc8441780462'},
        {'git_commit': 'cc3486ae50e6b831c33a9d8dae499d171ff37bfe', 'sha256': '70bbb437e56f5872f6adde8e454109bdbc9d9b052db387f26fddc1c9b3f53940'},
        {'git_commit': 'cd9b98485bf8e34b8e82bdc4d48cbebc47662f39', 'sha256': '88150546e67d4f634a7f02cce092376809e7dfff83811bcc909bcbb65e24f02e'},
        {'git_commit': 'cde978bab18bb2ffd064cfeec9bcb939eaaaa7b2', 'sha256': '47fa648b3582bcdb93b942d578dbf56bcc670649861f2d52793ec75e58099652'},
        {'git_commit': 'ce781724507e8e17ae6547f465e7ad58ea8061cb', 'sha256': '9d24da8c86f79de142ee144b72e31957774222342255c3f3afbeaa9a6d02a13b'},
        {'git_commit': 'd0093055dcf2d85368de55fe652ff47cc6d936c6', 'sha256': '153207bf41facf1d02125d60aa046fc46b9439ea7e19d9c19926839e39bd2460'},
        {'git_commit': 'd098f43926cdac0c5357f6951b63e4340a6b8bd2', 'sha256': '74dcfc6d6d07910fbe5677882d7b2a2fcc64fe335afaa0fc1161923d02092de3'},
        {'git_commit': 'd18613facddd9ca4b55f920cea2a0e7f101b2b2f', 'sha256': '7257866b9b16e670d54e3c18eeab7bf937581145ab9b58f439f05e027560f47e'},
        {'git_commit': 'd2ffcf034dc9b83a77e3564be52e3119c2b0a45f', 'sha256': 'fbf8fee55d66c6560328010426315436868d6b8e868ec58b5c5954241fcaa0fd'},
        {'git_commit': 'd33fa7fd0c8201c682a1a1b07464fd07fcca5c0a', 'sha256': '94bc887c1eb88d3f83a63b88ccf18c3512452d3c2c67fa00b52d1c9dbb290d03'},
        {'git_commit': 'd4f6ee21e26a410c724d9b9f553b2200c4d61cd3', 'sha256': '3fd0f2e2b20a485e7e3a498b7da38373932d8489d7c884af8982b0288b75c822'},
        {'git_commit': 'd52ca400aec50d547b9714234b21fe8053018144', 'sha256': '0ddbc9e81824a45a2d8e763b6fb045adf40d1bd20f64b821f033d09346044308'},
        {'git_commit': 'd5b55b8aa9f2ff96c830fb60ee9676a4615860c1', 'sha256': 'e0a4f680f67ea21f165e5b9182b9b62c5c1e9633fd6ee9f8ae51ab9e221c0cca'},
        {'git_commit': 'd63bb3c69c5056e46c8d285ecbd0267eac9a4bdf', 'sha256': '80d117839ea3ed0ad249d15a2104c2f096356f792462fa923658cca5b5c9d4d5'},
        {'git_commit': 'd66f66f70ddeaade24895b0d84c6e4629f3f0acf', 'sha256': '5bab0ecae621bca9fff8c06031e710a40bcf5328e353282d8b06e5b3c0516b2e'},
        {'git_commit': 'd7e0b47c202331e7c0eed098d5063b43169acded', 'sha256': 'a7e59f8526b1cabd8a6fbd24c294cca0971392345d0877c6deeb88b6b75444b8'},
        {'git_commit': 'd908e4ef113cb44cddc4767bb20841abb142d181', 'sha256': 'b196d67623c66d74da7ca96aa839cac4b1840cd1eac560c8803234f36a850d9e'},
        {'git_commit': 'da4a6c2c81278465176a3391c4f57c10c0903dc5', 'sha256': '6e504f5c428d43d104cd82ae36b9561e75c14378dc48df27c01c4d5146412760'},
        {'git_commit': 'da5c303556ef57577d5ef91432b9730a3c981cbe', 'sha256': '5088f0becc2d36d931b92c6ee6a59360aa5189f6dc0d88fc6b9decdd5dde5e1b'},
        {'git_commit': 'db84bf1f6c87846f90b5a7bf08c4af6cad4abad7', 'sha256': '982378483d44cd3fc55335d7702fccb89a06d164a58a3301e10e252c07cb8310'},
        {'git_commit': 'dc76056abf4f05d58e008b031ae45aae27bd0eff', 'sha256': '7a2d45ef44fa5768670aa32c28f73dd523f31f6f2ef04b34ca95fdfd297b314a'},
        {'git_commit': 'dcdaeac288321376c008d06a34988704b2daeee4', 'sha256': 'eaf894a20c1d51802714ff797ab7e421ddd3b013dd854f4631a53d24667f4429'},
        {'git_commit': 'ddbcf965d26ec5df1b84f607f7155780a711c4e8', 'sha256': '032026bc12c4fbb0764b6a072f7532bcd53e95b632de3351852cc0ce789a9305'},
        {'git_commit': 'ddf56f6ca7337bed878d605952ff12462db03366', 'sha256': '59732af59e91ebaf8aae4d72e1f92f39e2bb94f67dfd4668b783d18529779186'},
        {'git_commit': 'df49f3d495ef3432940b006f687c9c95a1e20e10', 'sha256': '283f68d6698b06d588cfa2ab885bbfd58133adf3b03bc535c90002ad0d69675b'},
        {'git_commit': 'e01da384e59b9fabbdb9182b4d5bba17d82afa53', 'sha256': '87d89284512e356876930b474630e2deb67c699087ff9fcdea22ea11a31a8b51'},
        {'git_commit': 'e0f28747e7dac6785c66e8b9ed9193acef2be132', 'sha256': '0b72f76e07d33a703e146bc3b7ee172c92420fba081da01e6113d15afed10dcb'},
        {'git_commit': 'e25fb38b2b78aa828a0171dc13bd33f2ada6c4ad', 'sha256': '19a87871df276f66f2409ed0766c0aa2e876f4c9baacfad5a53d9c486ac541d4'},
        {'git_commit': 'e28c891de841c12455d0b03c65321e38cc4b9fa4', 'sha256': 'bd73a88dddd83d53900e53ff723346da06dc672fe6903ef2c0fbc8e2dcc6c83f'},
        {'git_commit': 'e29254df608bb493fd8a9c059f91132187ace383', 'sha256': '5d8c60eb4329181ef28163e03ed5ddcfc7c8c0c963a388ad3f1de399a38e2e26'},
        {'git_commit': 'e371ced83ca19bd2b6d66188e37970f8ad72487c', 'sha256': '06e84d0bebca2b4f89b9e1184fd964acbe281d17de842b69ce8b93e7e337734c'},
        {'git_commit': 'e3b7560305e8f3c00921b2c6fdb32e48a49ea93d', 'sha256': '3da58c355e0865a8bc491de2bb804db8e938d79cb0c98efafbb7d2e9218e8ee5'},
        {'git_commit': 'e3e54caec0c1fb2ee62631b000cb2008a234096d', 'sha256': '9b20a4dc9972328aee787d653c5bc8c53ce2fe27bfe68a1599919eb7b0222c4a'},
        {'git_commit': 'e52fec2448ca8b3b4147d01baa6e9cb777b4ebd7', 'sha256': '73e46261b63f3e83c57a09906c118d74a8ff59fccdc2d9505809de14e60b5ec3'},
        {'git_commit': 'e84b2b9fc9f26d351ce3dac45357706d64292758', 'sha256': 'cb2b1c91230e56d1358369224447afe6981fa369283bf4f719a64e911e9dcd34'},
        {'git_commit': 'e893b84df839660f6b830fd5393d010b713eb12a', 'sha256': 'd552743981f042c7c661893e35745be3aba7543fbd8223f38e716bc8fba5804f'},
        {'git_commit': 'e8d01de1592de8a812ad5e08c1d5d45364c5800f', 'sha256': 'fab4aaf4ba67c99667dade522dc62f03ac2bedf89498f385d24b2fcd23834048'},
        {'git_commit': 'e930603f71043b54313d85ac8d78dc31f13861cb', 'sha256': '9e6e1d59e4c9041fff3db8601bdc3a3b97c01b3e7db9e182abd81cb3b00df0b4'},
        {'git_commit': 'e982e5639e71e430416c09b068f2def4615eb813', 'sha256': '49797625886ae880414790fc28a56f8d46995b0e87adc3675c73835da77278b6'},
        {'git_commit': 'e9883ac3581bd3f04757a2ce70c6aedd97b13aa1', 'sha256': 'cc7dc2ea4db34d1c7c20e8f38661fad70ea9b96e89fd5fddcccb4c60ef1fffbc'},
        {'git_commit': 'ea74b4c2226ed718c7316ac567c8c054c9e101a6', 'sha256': '27f7c859a9a7d262e6ba8066b44d4c110bf492124d35f5a1db65876d7b3613c0'},
        {'git_commit': 'eaa8265ae426b7c27b01db4651e379c66685f3d1', 'sha256': '4df1939082fb8ea4552bb2a3503e54236b299c7a6c6e4a795bec5876dc172089'},
        {'git_commit': 'eab3182fc841b7c657b4aa763f3d37e794aec2b9', 'sha256': '07e4c75512ea9619d74d07a97089c71110e09128e25470e6add7eeb8f689320e'},
        {'git_commit': 'eb1e70bc07fe4e201e20b5f8e84aba6020c384d7', 'sha256': '917d7f9094ece38a6160ed4136fe64966ffcc88c5a81ed51688dcaf468abc90e'},
        {'git_commit': 'ec1b48f572860810ceb0d7e45d1ac4e7e7d4501e', 'sha256': '6a59974ec7a82afb1871369603757cf10c78aad6efd0481bffaa4471a2b2e84b'},
        {'git_commit': 'ee85d315c953eaa62991a92182722c676b3167fe', 'sha256': '1612697d0af9fe104cbddccbd82b4cd17a7b28c2a3f3cb86ac154ce6c6e0c5b9'},
        {'git_commit': 'ef17461ed386125ab30d8464930fded2494a3157', 'sha256': '381ea436cafc7b46560c7f7d3b2eda4e0644548af36fd8e774b06d42b690e05b'},
        {'git_commit': 'ef8d4fb0e7b215ce27cf4ec107fef5e537a4807d', 'sha256': '6f7ed5096be3a6c8e0a94f18a6f02d4799f3d6c383e8d6ce27856acde40efdd1'},
        {'git_commit': 'f028f4afe337c6df2bc06e37dcb4560f4b3dda71', 'sha256': '6d247d8bb7b7c221936517d4168bcc3fae83315f0dca3d3a96bd10e5c4ce7aa9'},
        {'git_commit': 'f0dccdb56309c0ac4996d06b2084f08453f791b5', 'sha256': '6401b434cea401c092450159ed9b9cd94640bd0575a8bab6af24a8d0d15d0de2'},
        {'git_commit': 'f11be69c9fd92ef612f1664fce4a9a861759a8ff', 'sha256': '2528ec026c6a0bd3db635897de46020bd4eb29d5687690022bb0af3bf9a58395'},
        {'git_commit': 'f293022619a96d4fb98f6037d5ca8488f476688c', 'sha256': '1e52cdbd82af2fd604aa1a91abd61dcb82634bb89d87e511691234634c10b63e'},
        {'git_commit': 'f36b236a741dfe5f5a1b78621db09ef22320866a', 'sha256': '68ae647bf10eaf7091abefcc924d1e071769d52a6d07e0efb0396de3ebcc0b5b'},
        {'git_commit': 'f3f580e70f3a855304e43c5b04a8855b77018eec', 'sha256': '2436c36faaf47e9ffb146d55c295b7cfda139393e8bf5d203a76d452d51b958a'},
        {'git_commit': 'f4714382850943d9ad804231f6cdb0bebf9d4562', 'sha256': 'e10f5459ac5d05223a876ff602e70b5e8e0daee1c2f097706652253f732d7b8d'},
        {'git_commit': 'f4ab3af24ca927dd919021e8058e83343dd92bc3', 'sha256': '58bf79ee45339443e690b83e4fe29cfd06375f89aaa4dacf2671b0d29a5734b6'},
        {'git_commit': 'f53372136cf70e120e3f1758b558648b03da4983', 'sha256': 'f8e7bed16e2aefea67357c1ebf6597ca8ea2f3286a930505d5bea9d3135a2cb1'},
        {'git_commit': 'f53a35a66efd8f18c45bcb683d847b4dc24facb5', 'sha256': 'f24ff30b25216efea21d22214219b9b6eeeea5798230d57caba3a10305422f4c'},
        {'git_commit': 'f5ccb0546ade8d4ea8eeb7667e147cf12ef9bdef', 'sha256': 'd44a832e2237b5d7c72a0a8b22430895c9a211d94954abe3d5cc074a5bbd4853'},
        {'git_commit': 'f626671ba3922c91a145d1b71d8d4165b18254e7', 'sha256': '13285b230c261701daa89ff65c8bd45224ab73fe6b81aa59708724a4e17f4b1b'},
        {'git_commit': 'f66f298a84a76e5ff96b87602532bcd1ee363969', 'sha256': '38cc606be5b602013a20304be141a5e747319ed09b0d1a6c0223b49cde67ad8c'},
        {'git_commit': 'f698ba366773eb422d12f0220ece24d55d05182a', 'sha256': '02f443254be435b6b3dc560923860ac9f39ff0d6f8257c204d3787abf09c6981'},
        {'git_commit': 'f6ca2f468181a509f81fef1af02707f088bfc494', 'sha256': '33af5cd35b601b8223abda45dc966b4c1e22a768e6d3f69f749fddbab5d718c7'},
        {'git_commit': 'f7bcd160901077bb99d02f4f011378286254eda5', 'sha256': 'e777b045ab44231ce484c72cbf854698c3b6f5a61c01ed9925221ca779580a88'},
        {'git_commit': 'f808f8000b574a732e98782a0b3cf7de0dc2f370', 'sha256': '2cbca89299106c9387f467428d26f9005aad9a506c86df281ef609fcfaef0835'},
        {'git_commit': 'f8ed30e1cc01e6b9d7e15c835d48015af2507078', 'sha256': 'd9d76ec4bd6ed5a2521a2e4594489235d8da5269fedbdeb733e9706f051f72cb'},
        {'git_commit': 'fbcb444b2111f50afbccec474b6f22ff29beb1ff', 'sha256': 'cbb4ecb4ff7f0b272b0885a2d62f964c714dd319c38e35c7b9ed769c33ab17a8'},
        {'git_commit': 'fbce7e23e2fced98542641212d21b6de19658d3c', 'sha256': '6c0cd4317b92d56c426405e7d50e47576d78cf3b0465fc88af77c3695ce76477'},
        {'git_commit': 'fed7265f9866b3de0e047e4a6c683e70b3c575ac', 'sha256': '744f78b1a958ae1088a72c8c0fc41e009b67ad58985b71c7dbf212d7d74bf52b'},
        {'git_commit': 'feebd512a318ddbdff57ab24aa82a0280434b999', 'sha256': '2bb334f72b7b0e0071c8f551ed32956377fb4aeb79e2b892f956391b0e536a5c'},
        {'git_commit': 'ff4a0c8383f454e9932d6eb21d023cfff67be15f', 'sha256': '89b60ff4dccd7b7a70b6512d64836506d162992c88cdc649e984ecdd1b7aed1c'},
        {'git_commit': 'ffcf8a9927108fa6f8d4510e23c54c5b03d3fc57', 'sha256': '3a1c27c532e9d254f380c2f88fd3f12a9addd95ed963d6d389a1fd85cd96d9ba'},
    ],
    "materials": [
        {'surface': 'blob', 'git_commit': None, 'path': 'tests/comprehensive-api.test.mjs', 'sha256': '744d468f01f03367d00bd6891764c4050fbe6af1a195262ecab01b87ad64e013', 'lines': [{'line': 286, 'sha256': '4f41ae16367b26fa30edc37495d4ac3cf56439ea2ea3f9a9dd6fc74d38637e0e', 'label': 'generic assigned secret'}, {'line': 626, 'sha256': 'de8b7f8d66eecd3a042e052f69f3e3c0a207c3ad77d9f184126224e4a4cb761e', 'label': 'generic assigned secret'}, {'line': 627, 'sha256': '83843943335692633d4b47ee3e9dbb155e455dbb213ea7bf601e878446ba93d1', 'label': 'generic assigned secret'}]},
        {'surface': 'message', 'git_commit': '23670e3c90f1aa4c716ca1722e644c62144e8fa1', 'path': '', 'sha256': 'c4689f6a9cf81aa4a4d6c833dd7b397518210413595617ca83a121cc752cec00', 'lines': [{'line': 1, 'sha256': 'f94ee7ad3910065f4d6f8e414207d2843ca3ce2859393fde96d6fac89e844133', 'label': 'bare tracker number'}]},
        {'surface': 'blob', 'git_commit': None, 'path': 'tests/comprehensive-api.test.mjs', 'sha256': 'c9db67ccb36b8748b9a42431f9218b5d0d40db7cd69a6232240fd34f285e5029', 'lines': [{'line': 296, 'sha256': '4f41ae16367b26fa30edc37495d4ac3cf56439ea2ea3f9a9dd6fc74d38637e0e', 'label': 'generic assigned secret'}, {'line': 636, 'sha256': 'de8b7f8d66eecd3a042e052f69f3e3c0a207c3ad77d9f184126224e4a4cb761e', 'label': 'generic assigned secret'}, {'line': 637, 'sha256': '83843943335692633d4b47ee3e9dbb155e455dbb213ea7bf601e878446ba93d1', 'label': 'generic assigned secret'}]},
        {'surface': 'message', 'git_commit': '7af25fc0302c9f62995771449345fa740c7221f6', 'path': '', 'sha256': 'f1e60f3dabdbc5527dab2db0d0abd893a0b7d46ec02745ae8a539c43feef7698', 'lines': [{'line': 1, 'sha256': 'f9844ea35800b32a1aea5e5940da85ab4f8e9af22ba077f809902eb43804963b', 'label': 'bare tracker number'}]},
        {'surface': 'message', 'git_commit': '059657246ab7a656cc790d4ce51cedb5714a54cb', 'path': '', 'sha256': 'ffe61a6f6ceeba579706a27c0a05356dc8bf438c35b28e1f194a57c68722a80b', 'lines': [{'line': 1, 'sha256': '1a6d074ebf653a8841409023a15f90e0bb9c3dedb87e505b02724b7410715d50', 'label': 'bare tracker number'}]},
        {'surface': 'message', 'git_commit': 'da4a6c2c81278465176a3391c4f57c10c0903dc5', 'path': '', 'sha256': '90278b4bc9e65ca48078d22d9c5f385d45dbac4fcfb8ec8fec7321b75d897b60', 'lines': [{'line': 20, 'sha256': '4ded7543c7f8682957cdd83b2362dbbfa48c3977fd00a246735f464ebac2be0b', 'label': 'bare tracker number'}]},
        {'surface': 'blob', 'git_commit': None, 'path': 'tests/comprehensive-api.test.mjs', 'sha256': '853b4733bfa7dd5e77e74ad5fbcee4a6b2108af7fb7e2bd7c8a4439158826d7d', 'lines': [{'line': 347, 'sha256': '4f41ae16367b26fa30edc37495d4ac3cf56439ea2ea3f9a9dd6fc74d38637e0e', 'label': 'generic assigned secret'}, {'line': 687, 'sha256': 'de8b7f8d66eecd3a042e052f69f3e3c0a207c3ad77d9f184126224e4a4cb761e', 'label': 'generic assigned secret'}, {'line': 688, 'sha256': '83843943335692633d4b47ee3e9dbb155e455dbb213ea7bf601e878446ba93d1', 'label': 'generic assigned secret'}]},
        {'surface': 'message', 'git_commit': '09a1d069f556e7978f30a817277dc0328ef87b03', 'path': '', 'sha256': 'e77c8f66cfab3fe23bd120760c9b56fb33f154a38f225efb123ada6ffc2577ed', 'lines': [{'line': 1, 'sha256': '0e7c7df545ece1829d58f0e5de7fc84121ffaae00114a5b53786ea5dd9a3c7d9', 'label': 'bare tracker number'}]},
        {'surface': 'message', 'git_commit': '9c160fa042666f6e1ac2a6d39e4502dcadd20749', 'path': '', 'sha256': '3087f0d01b08b3a76d88df583acb0ab11f09f607fd0aef7213a00699a4a9c202', 'lines': [{'line': 1, 'sha256': '9b9de12dbd1427dc87d790d36e9a0b43aa2f65e99fdd7d4275ee902df4f7d641', 'label': 'bare tracker number'}]},
        {'surface': 'message', 'git_commit': 'fbcb444b2111f50afbccec474b6f22ff29beb1ff', 'path': '', 'sha256': '4e0e2a829d7c70a2dec377b90d8724bb0270d582265d5e6973e5644510578935', 'lines': [{'line': 1, 'sha256': '1a168d15e7b9aa78385493cf1fa4d973bce1be4a904aaae90d70b6ccf2599e5e', 'label': 'bare tracker number'}]},
        {'surface': 'message', 'git_commit': '1f738f82c2447371c5a7c8effae879d85edefbda', 'path': '', 'sha256': '50f10a37ce7e211adf2f770b5b38d0b37394f4218e4c64f1df343c2d2d0c8732', 'lines': [{'line': 1, 'sha256': 'eb85223a2fa3ded769e169580cd513849f0176ce5bb5aa30d1f4a58ce083546c', 'label': 'bare tracker number'}]},
        {'surface': 'blob', 'git_commit': None, 'path': 'tests/comprehensive-api.test.mjs', 'sha256': '12b5a4745325c98b41fbdc34fb325e78ef95b7d841dc0e8db55a3b5eff357c33', 'lines': [{'line': 347, 'sha256': '4f41ae16367b26fa30edc37495d4ac3cf56439ea2ea3f9a9dd6fc74d38637e0e', 'label': 'generic assigned secret'}, {'line': 687, 'sha256': 'de8b7f8d66eecd3a042e052f69f3e3c0a207c3ad77d9f184126224e4a4cb761e', 'label': 'generic assigned secret'}, {'line': 688, 'sha256': '83843943335692633d4b47ee3e9dbb155e455dbb213ea7bf601e878446ba93d1', 'label': 'generic assigned secret'}]},
        {'surface': 'message', 'git_commit': 'f808f8000b574a732e98782a0b3cf7de0dc2f370', 'path': '', 'sha256': '96734d480277573cae0b7a6327a5a0eaf37e03d99da5a38b7182bde8fd193753', 'lines': [{'line': 1, 'sha256': '6a7ad7518805b4455cd6b977e05f1054840c1134d1affc209231e05ce6366e75', 'label': 'bare tracker number'}]},
        {'surface': 'message', 'git_commit': 'f0dccdb56309c0ac4996d06b2084f08453f791b5', 'path': '', 'sha256': '23449fb43bcfbce4c09a774a04d6222edca3bd5438eabb66b4d6a60892b02ff9', 'lines': [{'line': 5, 'sha256': 'd5bafddc023a2a93ca932fd94f0ae0f936929105af9caaeb04d85dde89e0cd36', 'label': 'unclassified high-entropy credential'}]},
        {'surface': 'message', 'git_commit': '6924f271724defb12ce6b4d1526585c1b928928e', 'path': '', 'sha256': '1c1829cd6e347f375ec0ef3ede16de3088928b605e5caf50aefcfef4c814fca5', 'lines': [{'line': 1, 'sha256': '4e94e70434dce9c969ecafe87ea7f4194d93f760468ef43756df0bd2ad8dad51', 'label': 'unclassified high-entropy credential'}, {'line': 1, 'sha256': '4e94e70434dce9c969ecafe87ea7f4194d93f760468ef43756df0bd2ad8dad51', 'label': 'bare tracker number'}]},
        {'surface': 'message', 'git_commit': 'd7e0b47c202331e7c0eed098d5063b43169acded', 'path': '', 'sha256': '882843d16179bad248de688bdc78221be5baa678182f8b1995731e658237409c', 'lines': [{'line': 1, 'sha256': '49a925cfff64f5a12b83f6bccf6cabed988be8732d50056c88339270fd6f742e', 'label': 'bare tracker number'}]},
        {'surface': 'message', 'git_commit': 'ddbcf965d26ec5df1b84f607f7155780a711c4e8', 'path': '', 'sha256': '70087c0ee3125c9a0d9ad2a06c023896d2cb88eb175970b2a0811465da94bb6b', 'lines': [{'line': 1, 'sha256': '7c4c68f6155ad452f4a2cf136622a53e976c78ed779a9c272ae2213c9ec33cec', 'label': 'bare tracker number'}]},
        {'surface': 'message', 'git_commit': 'a752a7084d75155268ee5da4ee27dedb1761440a', 'path': '', 'sha256': 'dfd1b6d342b54e849a4712e933ec9cb10c5c28f900e30db30b57e5cdacd873e4', 'lines': [{'line': 1, 'sha256': '669f243b386519576dae7702be62e1b3f0e7f53e315d76731de188dc5e9e87ae', 'label': 'bare tracker number'}]},
        {'surface': 'blob', 'git_commit': None, 'path': 'tests/comprehensive-api.test.mjs', 'sha256': '99f72921a2af926cab0cfac3066c0be8fa6b686d0eab95797d40a757bd66492c', 'lines': [{'line': 347, 'sha256': '4f41ae16367b26fa30edc37495d4ac3cf56439ea2ea3f9a9dd6fc74d38637e0e', 'label': 'generic assigned secret'}, {'line': 687, 'sha256': 'de8b7f8d66eecd3a042e052f69f3e3c0a207c3ad77d9f184126224e4a4cb761e', 'label': 'generic assigned secret'}, {'line': 688, 'sha256': '83843943335692633d4b47ee3e9dbb155e455dbb213ea7bf601e878446ba93d1', 'label': 'generic assigned secret'}]},
        {'surface': 'message', 'git_commit': '1f8ce98f121b21c5d3872d5bbe37b324d40c4ff1', 'path': '', 'sha256': '8ad0ad9f1ef2f18a9db5fd6af7cd3d7f1e577104e2143d50a9247c1b7ff0a218', 'lines': [{'line': 3, 'sha256': '4fbf2c88e2ac9352c9efa3e0a5b2b1b215ba3dfb1267fd107d4adfa788988718', 'label': 'unclassified high-entropy credential'}]},
        {'surface': 'message', 'git_commit': '570f9429ffca905608f9832889e36697d57ca65a', 'path': '', 'sha256': '384c1c8352ff98fb2dac0c9738aa25c0dc2c0eaf5c46b601a26bd65a57b9165d', 'lines': [{'line': 1, 'sha256': 'e24ba6a8a503e547bbe47f87d5588b4f9dcc54dd29225e85113c3a6e36ddaf74', 'label': 'bare tracker number'}]},
        {'surface': 'message', 'git_commit': 'fed7265f9866b3de0e047e4a6c683e70b3c575ac', 'path': '', 'sha256': 'bb1437be04703641e6d7277a41983db20b3135a1111768c2c683e443d109a9b0', 'lines': [{'line': 1, 'sha256': 'c72935b09b3e985e02b59f044f6896383844b2c90e3f34511fd3b9d3a889b55e', 'label': 'bare tracker number'}]},
        {'surface': 'message', 'git_commit': 'f4ab3af24ca927dd919021e8058e83343dd92bc3', 'path': '', 'sha256': 'f5021f1ac7f3a64fe29ccfb71bf2d1920a73fc07c2e0eaab9f3121b65dc2fbb0', 'lines': [{'line': 1, 'sha256': '73393ee6c422805e1ec23f5f7e1031736fe072064678d7f030c9120f9853b638', 'label': 'unclassified high-entropy credential'}, {'line': 1, 'sha256': '73393ee6c422805e1ec23f5f7e1031736fe072064678d7f030c9120f9853b638', 'label': 'bare tracker number'}]},
        {'surface': 'message', 'git_commit': '334c88065aa446e65d9fa1535b6649cae9e117dd', 'path': '', 'sha256': '71805c0ffa5f4e268bb7459be785f2ea39da566615d93c5fb20d1e73de1ceea0', 'lines': [{'line': 1, 'sha256': '71805c0ffa5f4e268bb7459be785f2ea39da566615d93c5fb20d1e73de1ceea0', 'label': 'unclassified high-entropy credential'}]},
        {'surface': 'message', 'git_commit': '794ce05e3399185574ab01553e42bcd6b6cffdf1', 'path': '', 'sha256': 'eb314a3eff1d8b52af2551b8ebe00cf6d809df44552f190adb98b06e15417963', 'lines': [{'line': 31, 'sha256': 'd5bafddc023a2a93ca932fd94f0ae0f936929105af9caaeb04d85dde89e0cd36', 'label': 'unclassified high-entropy credential'}, {'line': 35, 'sha256': '88e0014856f67565f3615ba4bff40bbb3ed01be38b0dc8fe8ae6f1d34623d614', 'label': 'unclassified high-entropy credential'}]},
        {'surface': 'message', 'git_commit': '2eb57f6a270a6d5ac54dc7769a4cc8ad15fc6494', 'path': '', 'sha256': '563d6743450a7df65ebad738e1460f91f3b30351028e2688eaae0c889bb973b5', 'lines': [{'line': 1, 'sha256': '39f7bd452c53138b72769443297e07d13ef7941ed51f9a95444c0ccf16ca1d48', 'label': 'unclassified high-entropy credential'}, {'line': 1, 'sha256': '39f7bd452c53138b72769443297e07d13ef7941ed51f9a95444c0ccf16ca1d48', 'label': 'bare tracker number'}]},
        {'surface': 'message', 'git_commit': '6d380a455d35877b8c6e443d53478a2d68d7d345', 'path': '', 'sha256': '15d36d0168ea4b6b4bba76741a44e88622d02c63be31ff3142c8ff7eeb53fa0c', 'lines': [{'line': 1, 'sha256': '63a31e01ebdf2a56644ad588f96743a0b7592a067e16bb84542a3fc1ac15d50e', 'label': 'unclassified high-entropy credential'}, {'line': 1, 'sha256': '63a31e01ebdf2a56644ad588f96743a0b7592a067e16bb84542a3fc1ac15d50e', 'label': 'bare tracker number'}]},
        {'surface': 'message', 'git_commit': 'f3f580e70f3a855304e43c5b04a8855b77018eec', 'path': '', 'sha256': 'b66761f2c4f7330cce6f0b6df24ef84430682ddb1eb933046cbc1d1a82ef58f5', 'lines': [{'line': 1, 'sha256': '005e67ecea9f1a5dfabb5db306caf40a4480020886daafea0d64cb63f829a755', 'label': 'bare tracker number'}]},
        {'surface': 'message', 'git_commit': '9d490bdb8b1ec095f16f032c313c98181373ceb3', 'path': '', 'sha256': '22a413bb6f8b700b5d0a9da22e731be977318efd72e8b751a19ffd300babd7a7', 'lines': [{'line': 1, 'sha256': '20bc8d953119da3e7d4f20cdfeb46dec284af811a846d49ec532ed341714a6f4', 'label': 'bare tracker number'}]},
        {'surface': 'message', 'git_commit': '9aee991c20d7190f5058945ee481015f9cfda134', 'path': '', 'sha256': '41bf3dee2b16d8e3d2196fbce1e3504e45f272940e7806d96b79ddc4567931c9', 'lines': [{'line': 1, 'sha256': '233cfbbab67634202de3f581579b1f1fa1826b54c5719e21ea30e935422a44f6', 'label': 'unclassified high-entropy credential'}, {'line': 1, 'sha256': '233cfbbab67634202de3f581579b1f1fa1826b54c5719e21ea30e935422a44f6', 'label': 'bare tracker number'}]},
        {'surface': 'message', 'git_commit': 'ea74b4c2226ed718c7316ac567c8c054c9e101a6', 'path': '', 'sha256': '5156e37ebe99fe09f78a2cbd2bc9dfc07e81da62973ed8b6cd3d91e77e9eac26', 'lines': [{'line': 1, 'sha256': '2200f05a6b30276be09b2500021dcee86fc674e7b3a8377e55a84f02e7c69be3', 'label': 'bare tracker number'}]},
        {'surface': 'message', 'git_commit': '247efa92fd39a8e9cb2fcab71f555ffc40a5af07', 'path': '', 'sha256': '87cea17d0f0331ccfe5eec9ce316b706af062366b3ae9b19f81d6f93838d7a02', 'lines': [{'line': 1, 'sha256': '67c0f3488b0003788c71a96499caf92bbb815972f96d680817e152afce35ede9', 'label': 'bare tracker number'}]},
        {'surface': 'message', 'git_commit': '8d53ec49c7bc29b947e1a0cf3b76bc4315a949fe', 'path': '', 'sha256': '52c7391336dc8941d83319068029530e57ed47bf5040d5bf41e6d0ab33f4c6ff', 'lines': [{'line': 1, 'sha256': '5d377617c9ea969ebc0cd99acd697642308005dde43c4515e50b40fb38bc0370', 'label': 'bare tracker number'}]},
        {'surface': 'message', 'git_commit': '6c485491007426891867f12081f8c3a249bfced0', 'path': '', 'sha256': '4c04f964eea5bc9a13c08636659e931c507e522ea7a720b4b32d9e943a6cf192', 'lines': [{'line': 1, 'sha256': '3ca9c03349c3935e5b019b8d713a89ea9e928711c96d0ffe978461f4b86bcb4d', 'label': 'bare tracker number'}]},
        {'surface': 'message', 'git_commit': '0f126b48468c5652e073fcf9e3a8272d5fb92308', 'path': '', 'sha256': '99d24367882945ba53be029f39fc4617b71b8cdd34ec8a1607758e2da23529b1', 'lines': [{'line': 1, 'sha256': '4232bf95f17d55f300978cbb5fd77f3c094b0c9d96d777bd5c551fada2315f9f', 'label': 'bare tracker number'}]},
        {'surface': 'message', 'git_commit': '7147bef8be36fe478938c42f1e7ad27b4523d8b9', 'path': '', 'sha256': 'c124cdc46bf76568acddb17008ed9911fbf58b20303924880ec7260660976e77', 'lines': [{'line': 1, 'sha256': '71fae836fda21194b156ff5d9a1ada672d96db9f031f4a6cbcb4adcd64f686dd', 'label': 'bare tracker number'}]},
        {'surface': 'message', 'git_commit': 'c8eefa53bc9c773ca24ac73ac7d5de5bd6afbb47', 'path': '', 'sha256': '857ae52365ff5cbe80a7310c5bbb3e3da54541e1da368cd186a6d56b295bdd7f', 'lines': [{'line': 1, 'sha256': '3ca39c4aa286e0342d5f6d5cc0058020a47834fc8409a7e4b884fe041fc45212', 'label': 'bare tracker number'}]},
        {'surface': 'message', 'git_commit': '7515ff1c2502add0b83362580dea952ff50088ce', 'path': '', 'sha256': '2a66d653033fb18bbc05cf966fb6f5ddb1aa10fce0fbe28ba15ed13dcc826dc8', 'lines': [{'line': 1, 'sha256': 'c9fdf9d436525e84a24249592fd702a478c750a9b313c440afe12ca9adf0ecf8', 'label': 'bare tracker number'}]},
        {'surface': 'message', 'git_commit': '24af923e74aeb510ff3104bb427fb4a0d36b4151', 'path': '', 'sha256': 'ce852e729e3b849ffbe4d046c196c974f56aa821d57bd13bee6c13db68a61b62', 'lines': [{'line': 4, 'sha256': '88e0014856f67565f3615ba4bff40bbb3ed01be38b0dc8fe8ae6f1d34623d614', 'label': 'unclassified high-entropy credential'}]},
        {'surface': 'message', 'git_commit': '8cd8113cafe0e6a74547c1c3d1bb1e8054359e68', 'path': '', 'sha256': 'b8ed3b6cd5ba57ff72f8d68ae0d284ed4f3134757733cda4fa9d285cb945a89d', 'lines': [{'line': 5, 'sha256': 'd5bafddc023a2a93ca932fd94f0ae0f936929105af9caaeb04d85dde89e0cd36', 'label': 'unclassified high-entropy credential'}]},
        {'surface': 'message', 'git_commit': 'b08dc2af33b062aec6a5cdfaba804e064b80885a', 'path': '', 'sha256': '652283be82e4c781149a2aadb461ea369f3dd0b824fbc3b7f6df74627ed1fba4', 'lines': [{'line': 5, 'sha256': 'd5bafddc023a2a93ca932fd94f0ae0f936929105af9caaeb04d85dde89e0cd36', 'label': 'unclassified high-entropy credential'}]},
        {'surface': 'message', 'git_commit': '236db7d28c075466c51e7808ec59862524584362', 'path': '', 'sha256': 'db0b645380dda0618afc7d0b212f7b31f75c7c69bb2fccc083e802be92f98f02', 'lines': [{'line': 5, 'sha256': 'd5bafddc023a2a93ca932fd94f0ae0f936929105af9caaeb04d85dde89e0cd36', 'label': 'unclassified high-entropy credential'}]},
        {'surface': 'message', 'git_commit': 'e3b7560305e8f3c00921b2c6fdb32e48a49ea93d', 'path': '', 'sha256': 'd3c2c79ca16384a454b2fc4785119344f5e327ccf2c090d520d41dbf3e652879', 'lines': [{'line': 8, 'sha256': 'd5bafddc023a2a93ca932fd94f0ae0f936929105af9caaeb04d85dde89e0cd36', 'label': 'unclassified high-entropy credential'}, {'line': 12, 'sha256': '88e0014856f67565f3615ba4bff40bbb3ed01be38b0dc8fe8ae6f1d34623d614', 'label': 'unclassified high-entropy credential'}]},
        {'surface': 'message', 'git_commit': '608a8d634a89ad370b2ddd82972622ea8769e3d2', 'path': '', 'sha256': '67cbfdffe4857cd2e1f41db813979867d078a9bd8bae5992e5383ce5b9b66588', 'lines': [{'line': 18, 'sha256': 'd5bafddc023a2a93ca932fd94f0ae0f936929105af9caaeb04d85dde89e0cd36', 'label': 'unclassified high-entropy credential'}, {'line': 22, 'sha256': '88e0014856f67565f3615ba4bff40bbb3ed01be38b0dc8fe8ae6f1d34623d614', 'label': 'unclassified high-entropy credential'}]},
        {'surface': 'message', 'git_commit': '40ce7904c536cdfab56878782dab1f0e732dea10', 'path': '', 'sha256': '14db6894d4db7842a94df8c9ed8de93dcd34071900ee131738451985d53b8627', 'lines': [{'line': 8, 'sha256': 'd5bafddc023a2a93ca932fd94f0ae0f936929105af9caaeb04d85dde89e0cd36', 'label': 'unclassified high-entropy credential'}, {'line': 12, 'sha256': '88e0014856f67565f3615ba4bff40bbb3ed01be38b0dc8fe8ae6f1d34623d614', 'label': 'unclassified high-entropy credential'}]},
        {'surface': 'message', 'git_commit': 'ec1b48f572860810ceb0d7e45d1ac4e7e7d4501e', 'path': '', 'sha256': '0e19c3233f5673ba4113f44e8aa095ff338723a6bdb1fd726b0a417d7850b29f', 'lines': [{'line': 13, 'sha256': 'd5bafddc023a2a93ca932fd94f0ae0f936929105af9caaeb04d85dde89e0cd36', 'label': 'unclassified high-entropy credential'}]},
        {'surface': 'message', 'git_commit': 'e893b84df839660f6b830fd5393d010b713eb12a', 'path': '', 'sha256': '4ce42bcd5efbc8ae2eeb993bc482efc356191b2e8f86e84c610c5c7dd62ff6d0', 'lines': [{'line': 29, 'sha256': 'd5bafddc023a2a93ca932fd94f0ae0f936929105af9caaeb04d85dde89e0cd36', 'label': 'unclassified high-entropy credential'}, {'line': 43, 'sha256': '88e0014856f67565f3615ba4bff40bbb3ed01be38b0dc8fe8ae6f1d34623d614', 'label': 'unclassified high-entropy credential'}]},
        {'surface': 'message', 'git_commit': '5dd7fe6c24c81aea6f36fdcc0c4d2a2149532a9c', 'path': '', 'sha256': 'a8ad623429da9198786eba28df3d3d37759aa0ba859df92737409784f072aa12', 'lines': [{'line': 33, 'sha256': 'd5bafddc023a2a93ca932fd94f0ae0f936929105af9caaeb04d85dde89e0cd36', 'label': 'unclassified high-entropy credential'}, {'line': 47, 'sha256': '88e0014856f67565f3615ba4bff40bbb3ed01be38b0dc8fe8ae6f1d34623d614', 'label': 'unclassified high-entropy credential'}]},
        {'surface': 'message', 'git_commit': '026dfa5da7e66f67de3a05ffea22ca69e400e5e7', 'path': '', 'sha256': 'c23b31ec0da34faedbaa74db5c275e90f2c55386ff1332230e3ec5709d61347f', 'lines': [{'line': 15, 'sha256': '88e0014856f67565f3615ba4bff40bbb3ed01be38b0dc8fe8ae6f1d34623d614', 'label': 'unclassified high-entropy credential'}]},
        {'surface': 'message', 'git_commit': '7572df83a2fa7ee7e879b84224baf685df7918df', 'path': '', 'sha256': 'ea482793f134cbeea3b309353d56bcc4b0b5718f81f2f52243033d7fd4540647', 'lines': [{'line': 18, 'sha256': 'd5bafddc023a2a93ca932fd94f0ae0f936929105af9caaeb04d85dde89e0cd36', 'label': 'unclassified high-entropy credential'}]},
        {'surface': 'message', 'git_commit': '3f37c83c4280a06acb2b911e76155d933df63e0b', 'path': '', 'sha256': '1781d16b57281c84f2fe946e7a21c05e8f97b6b799ad9a65dbefb19fe4e27c89', 'lines': [{'line': 18, 'sha256': 'd5bafddc023a2a93ca932fd94f0ae0f936929105af9caaeb04d85dde89e0cd36', 'label': 'unclassified high-entropy credential'}]},
        {'surface': 'message', 'git_commit': 'f36b236a741dfe5f5a1b78621db09ef22320866a', 'path': '', 'sha256': 'f7906eab0bcbe3bc2b570cfd5a8bd040c48160199ce0802b70213389815a41ad', 'lines': [{'line': 13, 'sha256': 'd5bafddc023a2a93ca932fd94f0ae0f936929105af9caaeb04d85dde89e0cd36', 'label': 'unclassified high-entropy credential'}]},
        {'surface': 'message', 'git_commit': '6c9c954389d94421fb1c27b7e22e97e8f3c630b2', 'path': '', 'sha256': '5e968f6a4c6811cdc56e6110bcc1db1edf7cbcd20c7d4f38936b37b45e871f46', 'lines': [{'line': 8, 'sha256': 'd5bafddc023a2a93ca932fd94f0ae0f936929105af9caaeb04d85dde89e0cd36', 'label': 'unclassified high-entropy credential'}]},
        {'surface': 'message', 'git_commit': '30781d6ab044590db8e7a0c41358d94c60fb2167', 'path': '', 'sha256': '09dcd33b85eb82b775e84ea9d5d50a95aa4aa17476b4875381313cdb4fb33b4a', 'lines': [{'line': 8, 'sha256': 'd5bafddc023a2a93ca932fd94f0ae0f936929105af9caaeb04d85dde89e0cd36', 'label': 'unclassified high-entropy credential'}, {'line': 12, 'sha256': '88e0014856f67565f3615ba4bff40bbb3ed01be38b0dc8fe8ae6f1d34623d614', 'label': 'unclassified high-entropy credential'}]},
        {'surface': 'message', 'git_commit': '6ec1d89bb63b5835fcd0caf7c1d4d7e8aac4208c', 'path': '', 'sha256': '4ccfebcdec46778c353483d4a641f83428bda2b55b6389c28799372c2aac5d77', 'lines': [{'line': 13, 'sha256': 'd5bafddc023a2a93ca932fd94f0ae0f936929105af9caaeb04d85dde89e0cd36', 'label': 'unclassified high-entropy credential'}, {'line': 17, 'sha256': '88e0014856f67565f3615ba4bff40bbb3ed01be38b0dc8fe8ae6f1d34623d614', 'label': 'unclassified high-entropy credential'}]},
        {'surface': 'message', 'git_commit': '24c8877844fef9fa7f99e81aed617d605db77740', 'path': '', 'sha256': '40db42b5c932e2c03b832d0f76d20ca5776bd72db1708a7a46d6b628dbdf13f2', 'lines': [{'line': 1, 'sha256': '0fe97c280d21e063d6973d160fa9bb3fb3725135e6bed0e6729665c868fafb11', 'label': 'unclassified high-entropy credential'}]},
        {'surface': 'message', 'git_commit': 'cde978bab18bb2ffd064cfeec9bcb939eaaaa7b2', 'path': '', 'sha256': 'c687a03d1211093f3f3036556c0e257610916461a134f1f9e6de799ffa7eae37', 'lines': [{'line': 22, 'sha256': 'd5bafddc023a2a93ca932fd94f0ae0f936929105af9caaeb04d85dde89e0cd36', 'label': 'unclassified high-entropy credential'}, {'line': 36, 'sha256': '88e0014856f67565f3615ba4bff40bbb3ed01be38b0dc8fe8ae6f1d34623d614', 'label': 'unclassified high-entropy credential'}]},
        {'surface': 'message', 'git_commit': '1714a8ca892381dcd5601e4aa20837f586654a8e', 'path': '', 'sha256': '1b9982cfbaafcebc9c0e7a819ff714da7f6915c99d7bf62b55336f8dd893e667', 'lines': [{'line': 1, 'sha256': '91e9d32672c21dc8df98e864e049c107754a33987259b387ff0576a837dacf92', 'label': 'unclassified high-entropy credential'}]},
        {'surface': 'message', 'git_commit': 'e29254df608bb493fd8a9c059f91132187ace383', 'path': '', 'sha256': 'c4dbc7ee522a03a1d2c85cb0a37215afb424345ea3fcdda6596fd96965ff7abe', 'lines': [{'line': 1, 'sha256': '144b2f369c27fb4f9f326e4db2dc248f6515d094adc3d476f89630f293951f63', 'label': 'unclassified high-entropy credential'}]},
        {'surface': 'message', 'git_commit': 'eaa8265ae426b7c27b01db4651e379c66685f3d1', 'path': '', 'sha256': '5a80a30ff863faca5162a66774bdc1e26ee617575df135a199b388502d72295f', 'lines': [{'line': 1, 'sha256': 'cfaaf735637d81acbbb8d867d8d0e3343382fa5d8a77a590a6545920afd2bc9d', 'label': 'unclassified high-entropy credential'}]},
        {'surface': 'message', 'git_commit': '8d2ce0aed9286db3b4be45196959f7d749a09319', 'path': '', 'sha256': '313b1f313a492d21c2e5086a4a9525e16e2778161cbf7fdf01c590600edb2f55', 'lines': [{'line': 8, 'sha256': 'd5bafddc023a2a93ca932fd94f0ae0f936929105af9caaeb04d85dde89e0cd36', 'label': 'unclassified high-entropy credential'}, {'line': 22, 'sha256': '88e0014856f67565f3615ba4bff40bbb3ed01be38b0dc8fe8ae6f1d34623d614', 'label': 'unclassified high-entropy credential'}]},
        {'surface': 'message', 'git_commit': 'e8d01de1592de8a812ad5e08c1d5d45364c5800f', 'path': '', 'sha256': '704e0f21c39cc709af7fedac3fce5cf295e083cc3db585c0763797e11f9a545b', 'lines': [{'line': 22, 'sha256': 'd5bafddc023a2a93ca932fd94f0ae0f936929105af9caaeb04d85dde89e0cd36', 'label': 'unclassified high-entropy credential'}, {'line': 36, 'sha256': '88e0014856f67565f3615ba4bff40bbb3ed01be38b0dc8fe8ae6f1d34623d614', 'label': 'unclassified high-entropy credential'}]},
        {'surface': 'message', 'git_commit': 'aab412d402f9669bfe509b46b75e7eb81178a308', 'path': '', 'sha256': '200f083a092578d8165bef5992a2ec5a6a02736aa0677f0e6507449a8213347c', 'lines': [{'line': 22, 'sha256': '88e0014856f67565f3615ba4bff40bbb3ed01be38b0dc8fe8ae6f1d34623d614', 'label': 'unclassified high-entropy credential'}]},
        {'surface': 'message', 'git_commit': 'e982e5639e71e430416c09b068f2def4615eb813', 'path': '', 'sha256': '142438627157fe32453436a06c42de1116725e20f0164b0f5b0f52242a6bd52a', 'lines': [{'line': 34, 'sha256': '88e0014856f67565f3615ba4bff40bbb3ed01be38b0dc8fe8ae6f1d34623d614', 'label': 'unclassified high-entropy credential'}]},
        {'surface': 'message', 'git_commit': 'cd9b98485bf8e34b8e82bdc4d48cbebc47662f39', 'path': '', 'sha256': 'f8da426f5f14ae51ffb488947947de16821a40b605429055aab294a1283d9ee4', 'lines': [{'line': 15, 'sha256': '88e0014856f67565f3615ba4bff40bbb3ed01be38b0dc8fe8ae6f1d34623d614', 'label': 'unclassified high-entropy credential'}]},
        {'surface': 'message', 'git_commit': '40bec92ad7947ed75c54f4bc94b8403789febac3', 'path': '', 'sha256': '82dde2691a9d8495bcece7e740bc6e34f4f5fb404ac64c02f95e633246d967f0', 'lines': [{'line': 1, 'sha256': '8f52a6922344fd17f9d7cb6717f9bfc3909feaeb86e7c827c99ecb54d0e59ca9', 'label': 'unclassified high-entropy credential'}]},
        {'surface': 'message', 'git_commit': '34fb7fbe064ab00d2244d9a98194726c43c7b9ca', 'path': '', 'sha256': '19dac5855e3f875778fb3996bc471f2975b0a9caf280526bc0311df57c479a48', 'lines': [{'line': 1, 'sha256': 'b82b1cb54ab353580e6f4e4216d9f13e2c3bd85203ea853058de849c0c6f04c1', 'label': 'unclassified high-entropy credential'}]},
        {'surface': 'message', 'git_commit': 'c960b7bfcf3516d8fdeddf20cadacb36d52fe8d3', 'path': '', 'sha256': '063f679592cbf5df329423d1bba217247a0ef99577eef6b798d44d66a4f5062f', 'lines': [{'line': 1, 'sha256': '0f043ef1c82e690b2cf4156199cd98e58a00e4168384929e4d2c9d17090f19ea', 'label': 'unclassified high-entropy credential'}]},
        {'surface': 'message', 'git_commit': '3596ae192fe9507023cb0cf7e67fb8d4a384ed1d', 'path': '', 'sha256': 'cd9346c53d7a8e99fe8644390a29d70919f56bfebe452e4b425f5867ba52905f', 'lines': [{'line': 1, 'sha256': 'e647a383a30619ba1af6883dab39dd4a29d7a529c1c62dbbd4d434994c9d9192', 'label': 'unclassified high-entropy credential'}]},
        {'surface': 'message', 'git_commit': '0f8233be6e340d2771a6d734d1a4f3b5abbf2cd0', 'path': '', 'sha256': '2115a3676b33bfb9dcf56667253750b322b9e9de4e2d96b319b8456d9ec426b9', 'lines': [{'line': 1, 'sha256': 'affa1222c21e198d6cd117430693d0945e492b39e447372fde750b66d80661c3', 'label': 'unclassified high-entropy credential'}]},
        {'surface': 'binary', 'git_commit': None, 'path': 'client/public/android-chrome-192x192.png', 'sha256': '66d4621e070b36a8375bf6f842a3550bda48594bd6320d3e1d936ccc97b89504', 'bytes': 1948, 'lines': []},
        {'surface': 'binary', 'git_commit': None, 'path': 'client/public/android-chrome-512x512.png', 'sha256': '3898f35847a8ff19ea180482242bd31cd49e8897c8283b88f92a4fe8d7f0f3cf', 'bytes': 5656, 'lines': []},
        {'surface': 'binary', 'git_commit': None, 'path': 'client/public/apple-touch-icon.png', 'sha256': '6e982a4495e8ac42117d50fd9ba1f0390a74e8a9b64bd95a1468caeacf7e3a3e', 'bytes': 1774, 'lines': []},
        {'surface': 'binary', 'git_commit': None, 'path': 'client/public/favicon-16x16.png', 'sha256': 'a3a4b29c2e7d6d2b01644d0f141ae92a02fd0a24373a1e9a86a01f420e429e86', 'bytes': 242, 'lines': []},
        {'surface': 'binary', 'git_commit': None, 'path': 'client/public/favicon-32x32.png', 'sha256': 'fd6933b7090e2465a9d720e9a47dd44bec51d9246e1ff732fa86c2db10b2f18c', 'bytes': 487, 'lines': []},
        {'surface': 'binary', 'git_commit': None, 'path': 'client/public/favicon.ico', 'sha256': 'd109c8e33e20087417fbd6a2f443db71803eb00eab8ce0b383153e75ba80e698', 'bytes': 264, 'lines': []},
        {'surface': 'binary', 'git_commit': None, 'path': 'client/public/logo-256.png', 'sha256': '7c176d6eb1d447390bd6b233c0d03f271689c0491984d4e4ade18d2e4848cde9', 'bytes': 2668, 'lines': []},
        {'surface': 'binary', 'git_commit': None, 'path': 'client/public/android-chrome-192x192.png', 'sha256': '762c46240c4ad5c134080f1afe37acd78e98a751ec6c044d7b4d1cab3adb3f5c', 'bytes': 69956, 'lines': []},
        {'surface': 'binary', 'git_commit': None, 'path': 'client/public/android-chrome-512x512.png', 'sha256': '6f1ef2127366eaf67f1cae6eaca230304a2db18aaccb500fdb0cd0f66723c60c', 'bytes': 411992, 'lines': []},
        {'surface': 'binary', 'git_commit': None, 'path': 'client/public/apple-touch-icon.png', 'sha256': 'a45e0c6d923844ea8993b5fc19174a4a7e1a7859771b40376485f64f84c3395a', 'bytes': 61841, 'lines': []},
        {'surface': 'binary', 'git_commit': None, 'path': 'client/public/favicon-16x16.png', 'sha256': '3d98888ee33825d650c7b0cbc450e0f904b7b20c8a12aab170e521249dfd1b19', 'bytes': 810, 'lines': []},
        {'surface': 'binary', 'git_commit': None, 'path': 'client/public/favicon-32x32.png', 'sha256': '8658169f4893db5146c8ad51ffd6e0d262068b326c79bec477c07491bd34039a', 'bytes': 2548, 'lines': []},
        {'surface': 'binary', 'git_commit': None, 'path': 'client/public/favicon.ico', 'sha256': '5b96d101be321af11f3cac0337242ae53ca9806639f886ffe5da4bd6f80d601f', 'bytes': 832, 'lines': []},
        {'surface': 'binary', 'git_commit': None, 'path': 'client/public/logo-256.png', 'sha256': 'b574e141089b9427d49145f7bd32477705b8c183c1cc3380a79c2aea2c4dcc41', 'bytes': 116210, 'lines': []},
        {'surface': 'binary', 'git_commit': None, 'path': 'client/public/logo-512.png', 'sha256': '00930c1d93387c9c5d34cdbdf3ee59a0b0228c7f7a3370efa8bbfe766450cd93', 'bytes': 5929603, 'lines': []},
        {'surface': 'binary', 'git_commit': None, 'path': 'client/public/logo-256.png', 'sha256': 'a6b8ac54d8e8953aaec4e76202f38ef6d05818f7950929b3b4b0af47e416a18d', 'bytes': 87955, 'lines': []},
        {'surface': 'binary', 'git_commit': None, 'path': 'client/public/logo-512.png', 'sha256': 'f276ab53880f9711e1483ec37b4da8be36816f67787fff95b90fb1c5acc427ec', 'bytes': 327277, 'lines': []},
    ],
}

MAX_REVIEWED_HISTORY_ARTIFACT_BYTES = 6 * 1024 * 1024

BINARY_EXTENSIONS = {
    ".7z",
    ".avif",
    ".bin",
    ".bmp",
    ".class",
    ".dll",
    ".dylib",
    ".eot",
    ".exe",
    ".gif",
    ".gz",
    ".ico",
    ".jar",
    ".jpeg",
    ".jpg",
    ".pdf",
    ".png",
    ".so",
    ".tar",
    ".tif",
    ".tiff",
    ".ttf",
    ".wasm",
    ".webp",
    ".woff",
    ".woff2",
    ".xz",
    ".zip",
}

JAVASCRIPT_EXTENSIONS = {".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"}

FORBIDDEN_HOST_LABEL = "forbidden internal hostname"

# Rule-evasion backstops for encoded, wrapped, and defanged sensitive values.
# A short base64-encoded hostname stays under the high-entropy floor, so the
# embedded-string pass additionally decodes printable base64 runs and re-applies
# the host/IP/home-path rule set to the ASCII-decoded payload.
MIN_BASE64_DECODE_RUN = 8
MAX_BASE64_VARIANTS_PER_LINE = 128
BASE64_CANDIDATE = re.compile(
    r"(?P<value>[A-Za-z0-9+/=_-]{%d,})"
    % MIN_BASE64_DECODE_RUN
)
# The cross-line pass must not merge independent padded tokens or assignments
# into one equals-delimited candidate. Padding is unnecessary here because the
# decoder restores it after the line fragments have been joined.
BASE64_CROSS_LINE_CANDIDATE = re.compile(
    r"(?P<value>[A-Za-z0-9+/_-]{%d,})"
    % MIN_BASE64_DECODE_RUN
)
BASE64_PRINTABLE_RUN = re.compile(rb"[\t\r\n\x20-\x7e]+")
BASE64_RESCAN_LABELS = frozenset({
    FORBIDDEN_HOST_LABEL,
    "private 10.x IP",
    "private 192.168.x IP",
    "private 172.16-31.x IP",
    "private IPv6 address",
    "macOS home path",
    "Linux home path",
    "Windows home path",
})

# Keep the tracker token out of regex source so this gate can scan itself.
# WARNING: Do not copy string-splitting patterns like this into test fixtures, as it bypasses static scanners.
TRACKER_NAME = "gi" + "tea"


@dataclass(frozen=True)
class Finding:
    level: str
    path: str
    line: int
    label: str

    def as_text(self, _repo_name: str) -> str:
        location = hashlib.sha256(self.path.encode("utf-8", errors="surrogateescape")).hexdigest()[:12]
        return f"[{self.level}] location={location} line={self.line} {self.label}"

    def as_public_dict(self) -> dict[str, str | int]:
        return {
            "level": self.level,
            "location": hashlib.sha256(self.path.encode("utf-8", errors="surrogateescape")).hexdigest()[:12],
            "line": self.line,
            "label": self.label,
        }


@dataclass(frozen=True)
class PatternRule:
    level: str
    label: str
    pattern: re.Pattern[str]
    cross_line_pattern: re.Pattern[str] | None = None


@dataclass(frozen=True)
class TreeEntry:
    path: str
    object_id: str
    object_type: str


@dataclass(frozen=True)
class JsonObject:
    pairs: tuple[tuple[str, object], ...]


class DuplicateJsonKey(ValueError):
    pass


class Base64ScanLimit(ValueError):
    pass


BASE_RULES = (
    PatternRule("FAIL", "private key block", re.compile(r"-----BEGIN (?:RSA |DSA |EC |OPENSSH )?PRIVATE KEY-----")),
    PatternRule("FAIL", "GitHub token", re.compile(r"\bgh[pousr]_[A-Za-z0-9_]{20,}\b")),
    PatternRule("FAIL", "GitHub fine-grained token", re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}\b")),
    PatternRule("FAIL", "GitLab token", re.compile(r"\bglpat-[A-Za-z0-9_-]{20,}\b")),
    PatternRule("FAIL", "npm access token", re.compile(r"\bnpm_[A-Za-z0-9]{20,}\b")),
    PatternRule("FAIL", "Slack token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{20,}\b")),
    PatternRule("FAIL", "Stripe live secret", re.compile(r"\bsk_live_[A-Za-z0-9]{20,}\b")),
    PatternRule("FAIL", "Google API key", re.compile(r"\bAIza[A-Za-z0-9_-]{35}\b")),
    PatternRule("FAIL", "AWS access key ID", re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b")),
    PatternRule("FAIL", "OpenAI-style token", re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b")),
    PatternRule(
        "FAIL",
        "macOS home path",
        re.compile(r"/Users/[A-Za-z0-9_.-]+"),
    ),
    PatternRule(
        "FAIL",
        "Linux home path",
        re.compile(r"/home/[A-Za-z0-9_.-]+"),
    ),
    PatternRule(
        "FAIL",
        "Windows home path",
        re.compile(r"(?i)(?<![A-Za-z0-9])(?:[A-Z]:[\\/]|\\\\\?\\[A-Z]:\\)Users[\\/][^\\/\s]+[\\/]"),
    ),
    PatternRule("FAIL", "private 10.x IP", re.compile(r"\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b")),
    PatternRule("FAIL", "private 192.168.x IP", re.compile(r"\b192\.168\.\d{1,3}\.\d{1,3}\b")),
    PatternRule("FAIL", "private 172.16-31.x IP", re.compile(r"\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b")),
    PatternRule(
        "FAIL",
        "private IPv6 address",
        re.compile(r"(?i)(?<![0-9a-f:])(?:f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):[0-9a-f:]+"),
    ),
    PatternRule("FAIL", "MAC address", re.compile(r"\b(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\b")),
    PatternRule(
        "FAIL",
        "internal Gitea tracker URL",
        re.compile(
            rf"https?://[^/\s]*{TRACKER_NAME}[^/\s]*/\S+/(?:issues|pulls|milestones?)/\d+",
            re.IGNORECASE,
        ),
    ),
    PatternRule(
        "FAIL",
        "Gitea planning reference",
        re.compile(rf"(?i)\b{TRACKER_NAME}\b.{{0,80}}\b(?:issue|milestone|pull request|pr)\b"),
    ),
    PatternRule(
        "WARN",
        "bare tracker number",
        re.compile(r"(?i)\b(?:issue|milestone|pull request|pr)\s+#\d+\b"),
    ),
    PatternRule(
        "FAIL",
        "source-forge merge reference",
        re.compile(
            r"^Merge pull request ['\"].+['\"] \(#\d+\) from \S+ into \S+$",
            re.IGNORECASE,
        ),
    ),
)


JWT_CANDIDATE = re.compile(
    r"(?<![A-Za-z0-9_-])"
    r"(?P<header>eyJ[A-Za-z0-9_-]{5,2048})\."
    r"(?P<payload>[A-Za-z0-9_-]{5,8192})\."
    r"(?P<signature>[A-Za-z0-9_-]{8,8192})"
    r"(?![A-Za-z0-9_-])"
)

HIGH_ENTROPY_CANDIDATE = re.compile(
    r"(?<![A-Za-z0-9_+/=-])"
    r"(?P<value>[A-Za-z0-9_+/=-]{32,})"
    r"(?![A-Za-z0-9_+/=-])"
)

FROZEN_TAG_SOURCE_LINE = re.compile(
    r"(?:source: gitea/[0-9a-f]{40}|source-tree: [0-9a-f]{40})"
)
FROZEN_TAG_SOURCE_PREFIX = re.compile(
    r"(?:source: gitea/|source-tree: )[0-9a-f]{40}"
)
PGP_SIGNATURE_BEGIN = "-----BEGIN PGP SIGNATURE-----"
PGP_SIGNATURE_END = "-----END PGP SIGNATURE-----"

# These patterns allow only cryptographic material with an explicit public
# provenance or integrity role. A matching line does not suppress any other
# high-entropy candidate on that line.
REVIEWED_HIGH_ENTROPY_PATTERNS = (
    re.compile(
        r"(?i)\buses\s*:\s*[A-Za-z0-9_.-]+/[A-Za-z0-9_./-]+@"
        r"(?P<value>[0-9a-f]{40}|[0-9a-f]{64})(?=\s*(?:#.*)?$)"
    ),
    re.compile(
        r"(?i)\b(?:git[-_ ]?(?:sha|commit)|commit[-_ ](?:sha|id)|revision[-_ ](?:sha|id))\b"
        r"[\"']?\s*[:=]\s*[\"']?(?P<value>[0-9a-f]{40}|[0-9a-f]{64})[\"']?"
        r"(?=\s*(?:[,;#}]|$))"
    ),
    re.compile(
        r"(?i)(?<![A-Za-z0-9])(?:"
        r"sha256|sha384|sha512|asset[-_ ](?:hash|digest|sha256)"
        r"|(?:[A-Za-z][A-Za-z0-9]*[-_])+(?:sha256|sha384|sha512)"
        r")\b"
        r"[\"']?\s*[:=]\s*[\"']?"
        r"(?P<value>(?:sha(?:256|384|512):)?(?:[0-9a-f]{64}|[0-9a-f]{96}|[0-9a-f]{128}))"
        r"[\"']?(?=\s*(?:[,;#}\\]|$))"
    ),
    re.compile(
        r"(?i)(?<![A-Za-z0-9])(?:checksum|digest)\b"
        r"[\"']?\s*[:=]\s*[\"']?"
        r"(?P<value>sha(?:256|384|512):(?:[0-9a-f]{64}|[0-9a-f]{96}|[0-9a-f]{128}))"
        r"[\"']?(?=\s*(?:[,;#}\\]|$))"
    ),
    re.compile(
        r"(?i)\b_?integrity\b[\"']?\s*[:=]\s*[\"']?"
        r"(?P<value>sha(?:256|384|512)-[A-Za-z0-9+/]{32,}={0,2})"
        r"[\"']?(?=\s*(?:[,;#}]|$))"
    ),
    re.compile(
        r"(?i)\b[A-Za-z0-9._/-]+@(?P<value>sha256:[0-9a-f]{64})\b"
    ),
    re.compile(
        r"(?i)[\"'][^\"'\r\n]+\."
        r"(?:avif|css|gif|ico|jpe?g|js|map|png|svg|webmanifest|webp|woff2?)[\"']"
        r"\s*:\s*[\"'](?P<value>[0-9a-f]{64})[\"']"
        r"(?=\s*(?:[,;#}]|$))"
    ),
)

REVIEWED_HIGH_ENTROPY_CONTEXT_PATTERNS = (
    re.compile(
        r"(?is)\bexpect\(\s*(?:[A-Za-z_$][A-Za-z0-9_$]*)?"
        r"(?:installer|dockerfile)\s*\)"
        r"\.toContain\(\s*[\"']"
        r"(?P<value>[0-9a-f]{64}|[0-9a-f]{128})[\"']\s*,?\s*\)"
    ),
    re.compile(
        r"(?is)\bcreateHash\(\s*[\"']sha(?:256|512)[\"']\s*\)"
        r".{0,192}\bdigest\(\s*[\"']hex[\"']\s*\)\s*\)\.toBe\(\s*[\"']"
        r"(?P<value>[0-9a-f]{64}|[0-9a-f]{128})[\"']\s*,?\s*\)"
    ),
    re.compile(
        r"(?is)\bsha512sum\b.{0,256}\btest\b.{0,128}=\s*\\?\s*[\"']"
        r"(?P<value>[0-9a-f]{128})[\"']"
    ),
)

MAX_ARTIFACT_BYTES = 1024 * 1024
MAX_EMBEDDED_SCAN_BYTES = MAX_ARTIFACT_BYTES
MIN_RUN = 6
_ASCII_RUN = re.compile(rb"[\x20-\x7e]{%d,}" % MIN_RUN)
_PNG_SIG = b"\x89PNG\r\n\x1a\n"
MAX_HTTP_HEADER_LENGTH = 16 * 1024
MAX_COOKIE_PAIRS = 128
MAX_LOGICAL_LINES = 4
MAX_JSON_DEPTH = 128

HTTP_HEADER_MARKER = re.compile(
    r"(?i)['\"]?(?:authorization|set-cookie|cookie)['\"]?\s*[:=]"
)
BEARER_CREDENTIAL = re.compile(
    r"(?i)(?:['\"]?authorization['\"]?)\s*[:=]\s*['\"]?bearer\s+"
    r"(?P<value>[A-Za-z0-9._~+/%=-]{20,8192})"
)
COOKIE_HEADER = re.compile(
    r"(?i)(?:['\"]?(?:set-cookie|cookie)['\"]?)\s*[:=]\s*['\"]?(?P<body>.+)"
)
COOKIE_NAME = re.compile(r"[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}")
ASSIGNMENT_KEY = re.compile(
    r"(?i)(?<![A-Za-z0-9_-])(?P<quote>['\"]?)"
    r"(?P<identifier>[A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z0-9]+)*)"
    r"(?P=quote)\s*[:=]"
)
BRACKET_PROPERTY_ASSIGNMENT = re.compile(
    r"\[\s*(?P<quote>['\"])(?P<identifier>[A-Za-z][A-Za-z0-9_-]*)"
    r"(?P=quote)\s*\]\s*(?P<operator>[:=])"
)
YAML_BLOCK_INDICATOR = re.compile(
    r"(?P<operator>[:=])\s*[>|][0-9+-]*\s+"
)

PLACEHOLDER_MARKERS = {
    "dummy",
    "example",
    "placeholder",
    "sample",
    "synthetic",
    "your",
}

PLACEHOLDER_TERMINALS = {
    "access",
    "credential",
    "credentials",
    "hash",
    "key",
    "password",
    "placeholder",
    "secret",
    "token",
    "value",
}

HTTP_HEADER_NAMES = {
    "authorization": "Authorization",
    "cookie": "Cookie",
    "set-cookie": "Set-Cookie",
}

RAW_HEADER_CONTEXTS = {"header", "headers", "http-header", "http-headers"}
COOKIE_CONTEXTS = {"cookie", "cookies", "cookie-jar", "set-cookie", "set-cookies"}

CREDENTIAL_COOKIE_NAMES = {
    "access_token",
    "auth",
    "auth_token",
    "connect_sid",
    "csrf_token",
    "jwt",
    "refresh_token",
    "session",
    "session_id",
    "session_token",
    "sid",
    "token",
    "xsrf_token",
}

CREDENTIAL_COOKIE_SUFFIXES = (
    "_access_token",
    "_auth_token",
    "_refresh_token",
    "_session",
    "_session_id",
    "_session_token",
)


def identifier_components(identifier: str) -> list[str]:
    separated = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", identifier)
    return [component for component in re.split(r"[_-]+", separated.casefold()) if component]


def placeholder_reference(value: str) -> bool:
    if len(value) > 128 or not re.fullmatch(r"[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)+", value):
        return False
    raw_components = re.split(r"[-_]", value)
    components = [component.casefold() for component in raw_components]
    if components[0] not in PLACEHOLDER_MARKERS:
        return False
    numeric_suffix = components[-1].isdigit()
    terminal_index = -2 if numeric_suffix else -1
    if components[terminal_index] not in PLACEHOLDER_TERMINALS:
        return False
    for index, component in enumerate(raw_components):
        if len(component) > 20:
            return False
        if component.isdigit():
            if index != len(raw_components) - 1 or len(component) > 4:
                return False
        elif not component.isalpha():
            return False
    return True


def environment_reference(value: str) -> bool:
    return re.fullmatch(
        r"(?:process\.env\.[A-Za-z_][A-Za-z0-9_]*|"
        r"\$[A-Za-z_][A-Za-z0-9_]*|"
        r"\$\{[A-Za-z_$][A-Za-z0-9_$?.]*(?:\[[0-9]+\])?\}|"
        r"\$\{\{[^{}\r\n]{1,256}\}\})",
        value,
    ) is not None


def safe_secret_reference(value: str, quote: str, path: str, identifier: str) -> bool:
    normalized = value.rstrip(";,")
    if placeholder_reference(normalized):
        return True
    components = identifier_components(identifier)
    if normalized.startswith("/path/to/") and any(
        component in {"file", "path"} for component in components
    ):
        return True
    if environment_reference(normalized):
        return True
    if (
        any(component in {"endpoint", "uri", "url"} for component in components)
        and re.fullmatch(r"(?i)[a-z][a-z0-9+.-]*://\S+", normalized)
    ):
        return True
    return False


def safe_http_credential_reference(value: str) -> bool:
    normalized = value.strip().rstrip(";,\"'`")
    return placeholder_reference(normalized) or environment_reference(normalized)


def javascript_reference(value: str) -> bool:
    normalized = value.lstrip()
    return re.fullmatch(
        r"(?:await\s+)?(?:!{1,2}\s*)?[A-Za-z_$][A-Za-z0-9_$]*[^\r\n]*",
        normalized,
    ) is not None


def jwt_secret_rule(line: str) -> bool:
    for match in JWT_CANDIDATE.finditer(line):
        decoded = []
        try:
            for name in ("header", "payload"):
                segment = match.group(name)
                padding = "=" * (-len(segment) % 4)
                raw = base64.urlsafe_b64decode((segment + padding).encode("ascii"))
                decoded.append(json.loads(raw.decode("utf-8")))
        except (ValueError, UnicodeDecodeError):
            continue
        header, payload = decoded
        if (
            isinstance(header, dict)
            and isinstance(header.get("alg"), str)
            and header["alg"]
            and isinstance(payload, dict)
        ):
            return True
    return False


def shannon_entropy(value: str) -> float:
    if not value:
        return 0.0
    length = len(value)
    counts = Counter(value)
    return -sum(
        (count / length) * math.log2(count / length)
        for count in counts.values()
    )


def structured_public_reference(value: str) -> bool:
    components = [component for component in re.split(r"[_=/-]+", value) if component]
    if len(components) < 2:
        return False
    return all(
        re.fullmatch(r"[A-Za-z]+[0-9]{0,14}|[0-9]{1,14}", component)
        for component in components
    )


def high_entropy_value(value: str) -> bool:
    normalized = value.rstrip("=")
    if len(normalized) < 32 or placeholder_reference(normalized):
        return False
    if structured_public_reference(normalized):
        return False
    if re.fullmatch(r"[0-9a-fA-F]+", normalized):
        return (
            len(normalized) >= 32
            and len(set(normalized.casefold())) >= 12
            and shannon_entropy(normalized.casefold()) >= 3.5
        )
    character_groups = sum(
        bool(re.search(pattern, normalized))
        for pattern in (r"[a-z]", r"[A-Z]", r"[0-9]", r"[_+/=-]")
    )
    return (
        character_groups >= 2
        and len(set(normalized)) >= 16
        and shannon_entropy(normalized) >= 4.3
    )


def reviewed_high_entropy_spans(line: str) -> list[tuple[int, int, int, int]]:
    return [
        (*match.span(), *match.span("value"))
        for pattern in REVIEWED_HIGH_ENTROPY_PATTERNS
        for match in pattern.finditer(line)
        if not re.search(r"(?:^|\s)(?:#|//)", line[:match.start()])
    ]


def reviewed_high_entropy_context_values(context: str) -> set[str]:
    return {
        match.group("value")
        for pattern in REVIEWED_HIGH_ENTROPY_CONTEXT_PATTERNS
        for match in pattern.finditer(context)
    }


def high_entropy_credential_rule(line: str, context: str = "") -> bool:
    reviewed_spans = reviewed_high_entropy_spans(line)
    reviewed_values = reviewed_high_entropy_context_values(context)
    for match in HIGH_ENTROPY_CANDIDATE.finditer(line):
        value = match.group("value")
        if not high_entropy_value(value):
            continue
        start, end = match.span("value")
        if any(
            (value_start <= start and end <= value_end)
            or (
                start <= reviewed_start
                and reviewed_end <= end
                and start <= value_start
                and value_end <= end
            )
            for reviewed_start, reviewed_end, value_start, value_end in reviewed_spans
        ):
            continue
        if value in reviewed_values:
            continue
        return True
    return False


def secret_identifier(identifier: str) -> bool:
    components = identifier_components(identifier)
    has_api_key = any(
        left == "api" and right == "key"
        for left, right in zip(components, components[1:])
    )
    return has_api_key or (
        bool(components)
        and components[-1] in {"apikey", "passwd", "password", "secret", "token"}
    )


def assigned_secret_rule(line: str, path: str = "") -> bool:
    assignments = re.finditer(
        r"(?i)(?<![A-Za-z0-9_-])"
        r"(?P<key_quote>['\"]?)"
        r"(?P<identifier>[A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z0-9]+)*)"
        r"(?P=key_quote)"
        r"\s*[:=]\s*(?P<quote>['\"`]?)(?P<value>"
        r"\$\{[A-Za-z_$][A-Za-z0-9_$?.]*(?:\[[0-9]+\])?\}"
        r"|\$[A-Za-z_][A-Za-z0-9_]*"
        r"|process\.env\.[A-Za-z_][A-Za-z0-9_]*"
        r"|[^'\"`,\s}]{20,})(?P=quote)",
        line,
    )
    for match in assignments:
        if not secret_identifier(match.group("identifier")):
            continue

        value = match.group("value")
        if safe_secret_reference(
            value,
            match.group("quote"),
            path,
            match.group("identifier"),
        ):
            continue
        if (
            Path(path).suffix.lower() in JAVASCRIPT_EXTENSIONS
            and not match.group("quote")
            and javascript_reference(value)
        ):
            continue
        return True
    return False


def credential_cookie_name(name: str) -> bool:
    normalized = name.casefold()
    for prefix in ("__host-", "__secure-"):
        if normalized.startswith(prefix):
            normalized = normalized[len(prefix):]
            break
    normalized = re.sub(r"[.-]+", "_", normalized)
    return normalized in CREDENTIAL_COOKIE_NAMES or normalized.endswith(CREDENTIAL_COOKIE_SUFFIXES)


def cookie_credential_rule(body: str) -> bool:
    segments = body.split(";")
    if len(segments) > MAX_COOKIE_PAIRS:
        return True
    for segment in segments:
        raw_name, separator, raw_value = segment.partition("=")
        name = raw_name.strip()
        if not separator or not COOKIE_NAME.fullmatch(name) or not credential_cookie_name(name):
            continue
        value = raw_value.strip()
        if len(value) >= 2 and value[0] in "'\"" and value[-1] == value[0]:
            value = value[1:-1]
        if len(value) >= 20 and not safe_http_credential_reference(value):
            return True
    return False


def http_credential_rule(line: str, path: str = "") -> bool:
    del path
    if len(line) > MAX_HTTP_HEADER_LENGTH:
        return HTTP_HEADER_MARKER.search(line) is not None

    bearer = BEARER_CREDENTIAL.search(line)
    if bearer:
        if not safe_http_credential_reference(bearer.group("value")):
            return True

    header = COOKIE_HEADER.search(line)
    return bool(header and cookie_credential_rule(header.group("body")))


def normalize_logical_unit(value: str) -> str:
    normalized = BRACKET_PROPERTY_ASSIGNMENT.sub(
        lambda match: f" {match.group('identifier')} {match.group('operator')} ",
        value,
    )
    return YAML_BLOCK_INDICATOR.sub(
        lambda match: f"{match.group('operator')} ",
        normalized,
    )


def contextual_candidate(value: str) -> bool:
    if HTTP_HEADER_MARKER.search(value):
        return True
    return any(
        secret_identifier(match.group("identifier"))
        for match in ASSIGNMENT_KEY.finditer(value)
    )


def contextual_needs_continuation(value: str) -> bool:
    stripped = value.strip().rstrip(",;")
    return re.search(r"[:=]\s*(?:[>|][0-9+-]*)?$", stripped) is not None


def contextual_text_findings(text: str, path: str) -> set[tuple[str, str]]:
    result: set[tuple[str, str]] = set()
    lines = text.splitlines()
    for start, line in enumerate(lines):
        normalized_start = normalize_logical_unit(line)
        if not contextual_candidate(normalized_start):
            continue
        if assigned_secret_rule(normalized_start, path):
            result.add(("FAIL", "generic assigned secret"))
        if http_credential_rule(normalized_start, path):
            result.add(("FAIL", "HTTP credential"))
        if not contextual_needs_continuation(normalized_start):
            continue
        combined = line.strip()
        for offset in range(1, MAX_LOGICAL_LINES):
            if start + offset >= len(lines):
                break
            part = lines[start + offset].strip()
            if part:
                combined = f"{combined} {part}".strip()
            if len(combined) > MAX_HTTP_HEADER_LENGTH:
                break
            normalized = normalize_logical_unit(combined)
            if assigned_secret_rule(normalized, path):
                result.add(("FAIL", "generic assigned secret"))
            if http_credential_rule(normalized, path):
                result.add(("FAIL", "HTTP credential"))
    return result


def preserve_json_object(pairs: list[tuple[str, object]]) -> JsonObject:
    seen = set()
    for key, _value in pairs:
        if key in seen:
            raise DuplicateJsonKey
        seen.add(key)
    return JsonObject(tuple(pairs))


def reject_nonstandard_json_constant(_value: str) -> object:
    raise ValueError("non-standard JSON constant")


def normalized_context_key(value: str | None) -> str:
    return value.casefold().replace("_", "-") if value else ""


def canonical_http_header(value: str | None) -> str | None:
    return HTTP_HEADER_NAMES.get(normalized_context_key(value))


def iter_json_string_values(value: object) -> Iterator[str]:
    if isinstance(value, str):
        yield value
        return
    if not isinstance(value, list):
        return
    frames: list[tuple[Iterator[object], int]] = [(iter(value), 0)]
    while frames:
        iterator, depth = frames[-1]
        try:
            child = next(iterator)
        except StopIteration:
            frames.pop()
            continue
        if isinstance(child, str):
            yield child
        elif isinstance(child, list) and depth < MAX_JSON_DEPTH:
            frames.append((iter(child), depth + 1))


def iter_json_object_nodes(
    value: JsonObject,
    depth: int,
) -> Iterator[tuple[str | None, object, int]]:
    for child_key, child_value in value.pairs:
        yield str(child_key), child_value, depth + 1


def iter_json_list_nodes(
    key: str | None,
    value: list[object],
    depth: int,
) -> Iterator[tuple[str | None, object, int]]:
    for child_value in value:
        yield key, child_value, depth + 1


def named_json_object_has_http_credential(
    value: JsonObject,
    context_key: str | None,
    path: str,
) -> bool:
    fields = {
        normalized_context_key(key): child_value
        for key, child_value in value.pairs
    }
    name = fields.get("name")
    raw_values = fields.get("value")
    if not isinstance(name, str):
        return False
    header = canonical_http_header(name)
    context = normalized_context_key(context_key)
    for candidate in iter_json_string_values(raw_values):
        if header and http_credential_rule(f"{header}: {candidate}", path):
            return True
        if context in COOKIE_CONTEXTS and credential_cookie_name(name):
            if http_credential_rule(f"Cookie: {name}={candidate}", path):
                return True
    return False


def json_string_findings(
    key: str | None,
    value: str,
    path: str,
    rules: list[PatternRule],
    result: set[tuple[str, str]],
) -> None:
    if key and secret_identifier(key) and len(value) >= 20:
        if not safe_secret_reference(value, '"', path, key):
            result.add(("FAIL", "generic assigned secret"))

    context = normalized_context_key(key)
    header = canonical_http_header(key)
    if header and http_credential_rule(f"{header}: {value}", path):
        result.add(("FAIL", "HTTP credential"))
    elif context in RAW_HEADER_CONTEXTS and http_credential_rule(value, path):
        result.add(("FAIL", "HTTP credential"))
    elif context in COOKIE_CONTEXTS and http_credential_rule(f"Cookie: {value}", path):
        result.add(("FAIL", "HTTP credential"))

    if jwt_secret_rule(value):
        result.add(("FAIL", "JWT credential"))
    for rule in rules:
        if rule.pattern.search(value):
            result.add((rule.level, rule.label))


def structured_json_findings(
    text: str,
    path: str,
    rules: list[PatternRule],
) -> set[tuple[str, str]]:
    if Path(policy_path(path)).suffix.lower() != ".json":
        return set()
    try:
        payload = json.loads(
            text,
            object_pairs_hook=preserve_json_object,
            parse_constant=reject_nonstandard_json_constant,
        )
    except DuplicateJsonKey:
        return {("FAIL", "duplicate JSON key")}
    except (json.JSONDecodeError, RecursionError, ValueError):
        return {("FAIL", "invalid JSON artifact")}

    result: set[tuple[str, str]] = set()
    frames: list[Iterator[tuple[str | None, object, int]]] = [
        iter(((None, payload, 0),))
    ]
    while frames:
        iterator = frames[-1]
        try:
            key, value, depth = next(iterator)
        except StopIteration:
            frames.pop()
            continue
        if depth > MAX_JSON_DEPTH:
            result.add(("FAIL", "excessive JSON nesting"))
            continue
        if isinstance(value, JsonObject):
            if named_json_object_has_http_credential(value, key, path):
                result.add(("FAIL", "HTTP credential"))
            frames.append(iter_json_object_nodes(value, depth))
            continue
        if isinstance(value, list):
            frames.append(iter_json_list_nodes(key, value, depth))
            continue
        if isinstance(value, str):
            json_string_findings(key, value, path, rules, result)
    return result


def forbidden_host_rules(value: str) -> list[PatternRule]:
    # Separator alternation covers literal dots, encoded dots (%2e, \u002e,
    # \x2e, \056), defanged/redacted forms (build[.]corp, build(.)corp,
    # "build dot corp"), and JS string-concatenation splits ("a" + ".b").
    separator = (
        r"(?:\.|%2[eE]|\\u002[eE]|\\x2[eE]|\\056|"
        r"\[\s*(?:\.|dot)\s*\]|\(\s*(?:\.|dot)\s*\)|\s+dot\s+|"
        r"\.\s*[\"'`]\s*\+\s*[\"'`]\s*|"
        r"[\"'`]\s*\+\s*[\"'`]\s*\.)"
    )
    rules = []
    for raw in re.split(r"[,\s]+", value.strip()):
        if not raw:
            continue
        hostname = raw[2:] if raw.startswith("*.") else raw
        hostname = hostname.rstrip(".").casefold()
        labels = hostname.split(".")
        if (
            len(hostname) > 253 or
            any(
                not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
                for label in labels
            )
        ):
            return []
        cross_line_pattern = separator.join(re.escape(label) for label in labels)
        pattern = (
            r"(?<![A-Za-z0-9-])" +
            cross_line_pattern +
            r"(?![A-Za-z0-9-])"
        )
        rules.append(PatternRule(
            "FAIL",
            FORBIDDEN_HOST_LABEL,
            re.compile(pattern, re.IGNORECASE),
            re.compile(cross_line_pattern, re.IGNORECASE),
        ))
    return rules


def is_excluded(path: str, patterns: Iterable[str]) -> bool:
    return any(fnmatch.fnmatch(path, pattern) for pattern in patterns)


def policy_path(path: str) -> str:
    normalized = path.replace("\\", "/").strip("/")
    return re.sub(r"^commit-[0-9a-f]{12}/", "", normalized)


def sensitive_path_label(path: str) -> str | None:
    normalized = policy_path(path)
    if normalized in ALLOWED_PRIVATE_PATHS:
        return None
    parts = Path(normalized).parts
    name = parts[-1].lower() if parts else ""
    if name == ".env" or (name.startswith(".env.") and name != ".env.example"):
        return "environment file is forbidden"
    if name in PRIVATE_FILE_NAMES:
        return "credential artifact path is forbidden"
    if (
        (parts and parts[0] in PRIVATE_ROOT_DIRECTORIES)
        or any(part in PRIVATE_ANYWHERE_DIRECTORIES for part in parts[:-1])
        or normalized.startswith("client/coverage/")
    ):
        return "runtime or private evidence path is forbidden"
    if any(fnmatch.fnmatch(name, pattern) for pattern in PRIVATE_FILE_PATTERNS):
        return "credential or runtime database path is forbidden"
    return None


def record_path_finding(findings: list[Finding], path: str, label_prefix: str = "") -> None:
    label = sensitive_path_label(path)
    if label:
        findings.append(Finding("FAIL", path, 0, f"{label_prefix}{label}"))


def record_oversized_finding(
    findings: list[Finding],
    path: str,
    label_prefix: str = "",
) -> None:
    suffix = Path(policy_path(path)).suffix.lower()
    label = "oversized binary artifact" if suffix in BINARY_EXTENSIONS else "oversized text artifact"
    findings.append(Finding("FAIL", path, 0, f"{label_prefix}{label}"))


def load_allowlist_pathset(path: str) -> tuple[set[str] | None, str | None]:
    """Load and verify the export allowlist pathset emitted by the exporter.

    Consumes the exporter's normalized output (the provenance record's
    'pathset' array and 'pathsetSha256' digest, as produced by
    export-public-tree.mjs) without reinterpreting allowlist policy syntax.
    The digest is recomputed exactly as the exporter does (sha256 of the sorted
    path list joined by newlines with a trailing newline) and must match,
    making the pathset tamper-evident. Returns (pathset, error); on any failure
    the pathset is None and error is a fail-closed label.
    """
    try:
        with open(path, "r", encoding="utf-8") as stream:
            document = json.load(stream)
    except (OSError, ValueError):
        return None, "could not read export allowlist pathset"
    if not isinstance(document, dict):
        return None, "export allowlist pathset must be a JSON object"
    raw_paths = document.get("pathset")
    if not isinstance(raw_paths, list) or any(not isinstance(p, str) for p in raw_paths):
        return None, "export allowlist pathset must contain a 'pathset' array of strings"
    claimed = document.get("pathsetSha256")
    if not isinstance(claimed, str) or not re.fullmatch(r"[0-9a-f]{64}", claimed):
        return None, "export allowlist pathset must contain a 'pathsetSha256' sha256 digest"
    # JavaScript's default string ordering compares UTF-16 code units. Match
    # the exporter's ordering exactly, including for non-BMP path names.
    try:
        manifest = sorted(
            raw_paths,
            key=lambda value: value.encode("utf-16-be", errors="surrogatepass"),
        )
        manifest_blob = "\n".join(manifest) + "\n"
        actual = hashlib.sha256(manifest_blob.encode("utf-8")).hexdigest()
    except UnicodeEncodeError:
        return None, "export allowlist pathset contains an invalid path encoding"
    if actual != claimed:
        return None, "export allowlist pathset digest mismatch"
    return set(manifest), None


def record_allowlist_finding(
    findings: list[Finding],
    path: str,
    pathset: set[str] | None,
    label_prefix: str = "",
    *,
    allowlist_path: str | None = None,
) -> None:
    """Default-deny allowlist check in front of the blocklist scanner.

    A real path the gate walks that is not covered by the export allowlist
    pathset trips the gate regardless of whether its content looks clean. Only
    real tree/working-tree/commit-artifact paths are passed here; synthetic
    envelope surfaces (commit/tag metadata) are never checked against the
    pathset. The scanner remains the content backstop.
    """
    if pathset is None:
        return
    membership_path = path if allowlist_path is None else allowlist_path
    if membership_path not in pathset:
        findings.append(Finding(
            "FAIL",
            path,
            0,
            f"{label_prefix}path not covered by export allowlist",
        ))


def binary_path_allowed(path: str, digest: str) -> bool:
    normalized = policy_path(path)
    return ALLOWED_BINARY_ARTIFACTS.get(normalized) == digest


def decode_nul_paths(output: bytes) -> set[str]:
    return {os.fsdecode(item) for item in output.split(b"\0") if item}


def git_files(root: Path, include_untracked: bool) -> tuple[list[str], set[str]]:
    try:
        out = subprocess.check_output(["git", "ls-files", "-z"], cwd=root, stderr=subprocess.DEVNULL)
        tracked = {
            rel
            for rel in decode_nul_paths(out)
            if (root / rel).exists() or (root / rel).is_symlink()
        }
        files = set(tracked)
        if include_untracked:
            untracked = subprocess.check_output(
                ["git", "ls-files", "--others", "--exclude-standard", "-z"],
                cwd=root,
                stderr=subprocess.DEVNULL,
            )
            files.update(decode_nul_paths(untracked))
    except (FileNotFoundError, subprocess.CalledProcessError):
        files = {str(item.relative_to(root)) for item in root.rglob("*") if item.is_file()}
        return sorted(files), set()
    return sorted(files), tracked


def run_git(root: Path, *args: str, input_data: bytes | None = None) -> bytes:
    result = subprocess.run(
        ["git", *args],
        cwd=root,
        input=input_data,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode != 0:
        raise ValueError(f"git {args[0] if args else 'command'} failed")
    return result.stdout


@contextmanager
def without_git_replacement_objects() -> Iterator[None]:
    previous = os.environ.get("GIT_NO_REPLACE_OBJECTS")
    os.environ["GIT_NO_REPLACE_OBJECTS"] = "1"
    try:
        yield
    finally:
        if previous is None:
            os.environ.pop("GIT_NO_REPLACE_OBJECTS", None)
        else:
            os.environ["GIT_NO_REPLACE_OBJECTS"] = previous


def git_object_size(root: Path, object_spec: str) -> int:
    raw_size = run_git(root, "cat-file", "-s", object_spec).decode("ascii").strip()
    if not raw_size.isdigit():
        raise ValueError("invalid Git object size")
    return int(raw_size)


def git_succeeds(root: Path, *args: str) -> bool:
    return (
        subprocess.run(
            ["git", *args],
            cwd=root,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        ).returncode
        == 0
    )


def load_excludes(extra_excludes: list[str]) -> list[str]:
    excludes = list(DEFAULT_EXCLUDES)
    excludes.extend(extra_excludes)
    return excludes


def decode_text(data: bytes) -> str | None:
    if b"\0" in data:
        return None
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return None
    if any((ord(char) < 32 and char not in "\t\n\r\f") or 0x7F <= ord(char) <= 0x9F for char in text):
        return None
    return text


def tag_message_high_entropy_policy(text: str) -> tuple[set[int], set[int], bool | None]:
    lines = text.splitlines()
    try:
        message_start = lines.index("") + 1
    except ValueError:
        return set(), set(), None

    exempt_lines: set[int] = set()
    forced_lines: set[int] = set()
    for line_no, line in enumerate(lines[message_start:], message_start + 1):
        if FROZEN_TAG_SOURCE_LINE.fullmatch(line):
            exempt_lines.add(line_no)
        elif FROZEN_TAG_SOURCE_PREFIX.match(line):
            forced_lines.add(line_no)

    begins = [index for index, line in enumerate(lines)
              if line in {PGP_SIGNATURE_BEGIN, "-----BEGIN SSH SIGNATURE-----"}]
    if not begins:
        return exempt_lines, forced_lines, None
    admitted = False
    if len(begins) == 1 and begins[0] >= message_start:
        raw_lines = text.encode("utf-8").split(b"\n")
        start = begins[0]
        signature_lines = raw_lines[start:]
        if signature_lines and not signature_lines[-1]:
            signature_lines.pop()
        payload = b"\n".join(raw_lines[:start]) + b"\n"
        classified = verified_signature_entropy_lines(signature_lines, payload)
        admitted = bool(classified)
        exempt_lines.update(start + line_no for line_no in classified)
    return exempt_lines, forced_lines, admitted


def iter_base64_decoded(
    line: str,
    max_variants: int = MAX_BASE64_VARIANTS_PER_LINE,
) -> Iterator[str]:
    """Yield unique printable ASCII results of decoding base64 runs in a line.

    Covers standard and URL-safe alphabets. Bounded per candidate so a
    pathological equals-delimited run cannot amplify work or starve a later
    match. Non-printable bytes delimit printable runs instead of discarding a
    later host/IP/path in the same decoded candidate.
    """
    seen: set[str] = set()
    for match in BASE64_CANDIDATE.finditer(line):
        variants_seen = 0
        candidate = match.group("value")
        candidates = [candidate]
        candidate_set = {candidate}
        without_padding = candidate.rstrip("=")
        if (
            without_padding != candidate
            and len(without_padding) >= MIN_BASE64_DECODE_RUN
        ):
            candidates.append(without_padding)
            candidate_set.add(without_padding)
        if "=" in without_padding:
            for segment in without_padding.split("="):
                if (
                    len(segment) >= MIN_BASE64_DECODE_RUN
                    and segment not in candidate_set
                ):
                    candidates.append(segment)
                    candidate_set.add(segment)
        # Strict decode accepting both the standard (+/) and URL-safe (-_) base64
        # alphabets. altchars=b'-_' keeps validate=True enforcement available on
        # every supported Python (urlsafe_b64decode dropped the validate kwarg in
        # 3.14), while the base alphabet already accepts '+/'.
        # A base64 token may be unpadded or directly adjacent to another
        # alphanumeric token. Trying the four possible alignments at both
        # edges keeps the work bounded (at most 16 decodes per candidate)
        # while recovering independently encoded payloads.
        for candidate_variant in candidates:
            variants_seen += 1
            if variants_seen > max_variants:
                raise Base64ScanLimit
            for offset in range(min(4, len(candidate_variant) - MIN_BASE64_DECODE_RUN + 1)):
                aligned = candidate_variant[offset:]
                trim_count = min(4, len(aligned) - MIN_BASE64_DECODE_RUN + 1)
                for trim in range(trim_count):
                    trimmed = aligned[:-trim] if trim else aligned
                    padded = trimmed + "=" * (-len(trimmed) % 4)
                    try:
                        decoded_bytes = base64.b64decode(
                            padded,
                            altchars=b"-_",
                            validate=True,
                        )
                    except binascii.Error:
                        continue
                    for printable_run in BASE64_PRINTABLE_RUN.findall(decoded_bytes):
                        decoded = printable_run.decode("ascii")
                        if decoded in seen:
                            continue
                        seen.add(decoded)
                        yield decoded


def apply_line_rules(
    findings: list[Finding],
    path: str,
    text: str,
    rules: list[PatternRule],
    label_prefix: str = "",
    *,
    high_entropy: bool = True,
    high_entropy_exempt_lines: set[int] | None = None,
    forced_high_entropy_lines: set[int] | None = None,
) -> None:
    entropy_exemptions = high_entropy_exempt_lines or set()
    forced_entropy_findings = forced_high_entropy_lines or set()
    matched_base64_rules: set[PatternRule] = set()
    base64_limit_hit = False
    lines = text.splitlines()
    for line_no, line in enumerate(lines, 1):
        context_start = max(0, line_no - MAX_LOGICAL_LINES)
        context_end = min(len(lines), line_no + 1)
        line_context = "\n".join(lines[context_start:context_end])
        if assigned_secret_rule(line, path):
            findings.append(Finding("FAIL", path, line_no, f"{label_prefix}generic assigned secret"))
        if http_credential_rule(line, path):
            findings.append(Finding("FAIL", path, line_no, f"{label_prefix}HTTP credential"))
        if jwt_secret_rule(line):
            findings.append(Finding("FAIL", path, line_no, f"{label_prefix}JWT credential"))
        reviewed_tag_object = (
            label_prefix == "tag metadata: " and
            re.fullmatch(r"object (?:[0-9a-f]{40}|[0-9a-f]{64})", line) is not None
        )
        if (
            high_entropy and
            line_no not in entropy_exemptions and
            (
                line_no in forced_entropy_findings or
                high_entropy_credential_rule(line, line_context)
            ) and
            not reviewed_tag_object
        ):
            findings.append(Finding(
                "FAIL",
                path,
                line_no,
                f"{label_prefix}unclassified high-entropy credential",
            ))
        for rule in rules:
            if rule.pattern.search(line):
                findings.append(Finding(rule.level, path, line_no, f"{label_prefix}{rule.label}"))
        try:
            for decoded in iter_base64_decoded(line):
                for rule in rules:
                    if rule.label not in BASE64_RESCAN_LABELS:
                        continue
                    if rule.pattern.search(decoded):
                        matched_base64_rules.add(rule)
                        findings.append(Finding(
                            "FAIL",
                            path,
                            line_no,
                            f"{label_prefix}embedded base64: {rule.label}",
                        ))
        except Base64ScanLimit:
            base64_limit_hit = True
            findings.append(Finding(
                "FAIL",
                path,
                line_no,
                f"{label_prefix}base64 scan variant limit exceeded",
            ))

    # A forbidden hostname or encoded value may be wrapped across line breaks;
    # the per-line pass above cannot see it. Flatten the file once, then decode
    # only regex matches that actually cross a line boundary. Candidate limits
    # stay local to each match, so unrelated earlier content cannot starve a
    # later cross-line payload.
    flattened_parts: list[str] = []
    flattened_line_starts: list[int] = []
    flattened_length = 0
    for line in lines:
        flattened_line_starts.append(flattened_length)
        part = line.strip(" \t")
        flattened_parts.append(part)
        flattened_length += len(part)
    flattened = "".join(flattened_parts)

    def flattened_line_number(offset: int) -> int:
        if not flattened_line_starts:
            return 1
        return bisect_right(flattened_line_starts, offset)

    flattened_line_start_set = set(flattened_line_starts)

    def crosses_line_boundary(match: re.Match[str]) -> bool:
        next_line_index = bisect_right(flattened_line_starts, match.start())
        return (
            next_line_index < len(flattened_line_starts)
            and flattened_line_starts[next_line_index] < match.end()
        )

    def has_host_boundaries(match: re.Match[str]) -> bool:
        left_boundary = (
            match.start() == 0
            or match.start() in flattened_line_start_set
            or re.fullmatch(r"[A-Za-z0-9-]", flattened[match.start() - 1]) is None
        )
        right_boundary = (
            match.end() == len(flattened)
            or match.end() in flattened_line_start_set
            or re.fullmatch(r"[A-Za-z0-9-]", flattened[match.end()]) is None
        )
        return left_boundary and right_boundary

    matched_flattened_rules = {
        rule
        for rule in rules
        if rule.label == FORBIDDEN_HOST_LABEL
        and any(rule.pattern.search(line) for line in lines)
    }
    for rule in rules:
        if (
            rule.label != FORBIDDEN_HOST_LABEL
            or rule in matched_flattened_rules
        ):
            continue
        cross_line_pattern = rule.cross_line_pattern or rule.pattern
        for match in cross_line_pattern.finditer(flattened):
            if not crosses_line_boundary(match) or not has_host_boundaries(match):
                continue
            matched_flattened_rules.add(rule)
            findings.append(Finding(
                "FAIL",
                path,
                flattened_line_number(match.start()),
                f"{label_prefix}{rule.label}",
            ))
            break

    if not base64_limit_hit:
        for match in BASE64_CROSS_LINE_CANDIDATE.finditer(flattened):
            if not crosses_line_boundary(match):
                continue
            line_no = flattened_line_number(match.start())
            try:
                for decoded in iter_base64_decoded(match.group("value")):
                    for rule in rules:
                        if rule.label not in BASE64_RESCAN_LABELS:
                            continue
                        if rule in matched_base64_rules:
                            continue
                        rescan_pattern = rule.cross_line_pattern or rule.pattern
                        if rescan_pattern.search(decoded):
                            matched_base64_rules.add(rule)
                            findings.append(Finding(
                                "FAIL",
                                path,
                                line_no,
                                f"{label_prefix}embedded base64: {rule.label}",
                            ))
            except Base64ScanLimit:
                findings.append(Finding(
                    "FAIL",
                    path,
                    line_no,
                    f"{label_prefix}base64 scan variant limit exceeded",
                ))
                break


def _decode_utf16_runs(data: bytes, encoding: str) -> Iterator[str]:
    for offset in (0, 1):
        text = data[offset:].decode(encoding, errors="ignore")
        for run in re.findall(r"[\x20-\x7e]{%d,}" % MIN_RUN, text):
            yield run


def iter_png_text_chunks(data: bytes) -> Iterator[str]:
    if not data.startswith(_PNG_SIG):
        return
    offset = len(_PNG_SIG)
    expanded_total = 0
    while offset + 8 <= len(data):
        length = int.from_bytes(data[offset:offset + 4], "big")
        chunk_type = data[offset + 4:offset + 8]
        body = data[offset + 8:offset + 8 + length]
        offset += 12 + length
        if length < 0 or offset > len(data) + 4:
            return
        if chunk_type == b"tEXt":
            yield body.replace(b"\0", b": ").decode("latin-1", errors="ignore")
        elif chunk_type == b"iTXt":
            yield body.decode("utf-8", errors="ignore")
        elif chunk_type == b"zTXt":
            keyword, _, compressed = body.partition(b"\0")
            try:
                import zlib
                decompressor = zlib.decompressobj()
                remaining = MAX_EMBEDDED_SCAN_BYTES - expanded_total
                expanded = decompressor.decompress(
                    compressed[1:],
                    remaining + 1,
                )
            except Exception:
                continue
            if (
                len(expanded) > remaining or
                decompressor.unconsumed_tail or
                not decompressor.eof
            ):
                raise ValueError("oversized PNG text chunk")
            expanded_total += len(expanded)
            yield (
                keyword.decode("latin-1", "ignore") + ": " +
                expanded.decode("latin-1", "ignore")
            )


def iter_embedded_strings(data: bytes) -> Iterator[str]:
    window = data[:MAX_EMBEDDED_SCAN_BYTES]
    for run in _ASCII_RUN.findall(window):
        yield run.decode("ascii")
    yield from _decode_utf16_runs(window, "utf-16le")
    yield from _decode_utf16_runs(window, "utf-16be")
    yield from iter_png_text_chunks(window)


def scan_embedded_strings(
    findings: list[Finding],
    path: str,
    data: bytes,
    rules: list[PatternRule],
    label_prefix: str = "",
) -> None:
    prefix = f"{label_prefix}embedded string: "
    for run in iter_embedded_strings(data):
        apply_line_rules(
            findings,
            path,
            run,
            rules,
            prefix,
            high_entropy=False,
        )


def scan_blob(
    findings: list[Finding],
    path: str,
    data: bytes,
    rules: list[PatternRule],
    label_prefix: str = "",
    *,
    high_entropy_exempt_lines: set[int] | None = None,
    forced_high_entropy_lines: set[int] | None = None,
    reviewed_material: dict | None = None,
) -> str | None:
    declared_binary = Path(policy_path(path)).suffix.lower() in BINARY_EXTENSIONS
    reviewed_bytes = (
        reviewed_material is not None
        and hashlib.sha256(data).hexdigest() == reviewed_material.get("sha256")
    )
    reviewed_binary = (
        reviewed_bytes
        and reviewed_material.get("surface") == "binary"
        and reviewed_material.get("path") == policy_path(path)
        and reviewed_material.get("bytes") == len(data)
        and len(data) <= MAX_REVIEWED_HISTORY_ARTIFACT_BYTES
    )
    if len(data) > MAX_ARTIFACT_BYTES and not reviewed_binary:
        record_oversized_finding(findings, path, label_prefix)
        return None
    if data.startswith(b"version https://git-lfs.github.com/spec/"):
        findings.append(Finding(
            "FAIL",
            path,
            0,
            f"{label_prefix}git-lfs pointer: content not scannable",
        ))
        return None
    text = None if declared_binary else decode_text(data)
    if text is None:
        digest = hashlib.sha256(data).hexdigest()
        if not binary_path_allowed(path, digest) and not reviewed_binary:
            findings.append(Finding("FAIL", path, 0, f"{label_prefix}unreviewed binary artifact"))
        scan_embedded_strings(findings, path, data, rules, label_prefix)
        return digest
    initial_finding_count = len(findings)
    apply_line_rules(
        findings,
        path,
        text,
        rules,
        label_prefix,
        high_entropy_exempt_lines=high_entropy_exempt_lines,
        forced_high_entropy_lines=forced_high_entropy_lines,
    )
    existing_labels = {
        finding.label for finding in findings[initial_finding_count:]
    }
    additional_findings = contextual_text_findings(text, path)
    additional_findings.update(structured_json_findings(text, path, rules))
    for level, label in additional_findings:
        full_label = f"{label_prefix}{label}"
        if full_label not in existing_labels:
            findings.append(Finding(level, path, 0, full_label))
            existing_labels.add(full_label)
    if reviewed_bytes:
        allowed_labels = {"generic assigned secret", "unclassified high-entropy credential", "bare tracker number"}
        lines = data.splitlines()
        bindings = {
            (binding["line"], f"{label_prefix}{binding['label']}")
            for binding in reviewed_material.get("lines", [])
            if binding.get("label") in allowed_labels
            and isinstance(binding.get("line"), int)
            and 1 <= binding["line"] <= len(lines)
            and hashlib.sha256(lines[binding["line"] - 1]).hexdigest() == binding.get("sha256")
        }
        findings[initial_finding_count:] = [
            finding for finding in findings[initial_finding_count:]
            if (finding.line, finding.label) not in bindings
        ]
    return None


def tree_entries(root: Path, ref: str) -> list[TreeEntry]:
    output = run_git(root, "ls-tree", "-r", "-z", "--full-tree", ref)
    entries: list[TreeEntry] = []
    for raw_entry in output.split(b"\0"):
        if not raw_entry:
            continue
        try:
            metadata, raw_path = raw_entry.split(b"\t", 1)
            _mode, object_type, object_id = metadata.split()
            decoded_id = object_id.decode("ascii")
            decoded_type = object_type.decode("ascii")
        except (UnicodeDecodeError, ValueError) as exc:
            raise ValueError("invalid Git tree entry") from exc
        entries.append(TreeEntry(os.fsdecode(raw_path), decoded_id, decoded_type))
    return entries


def read_exact(stream: BinaryIO, size: int) -> bytes:
    chunks = bytearray()
    while len(chunks) < size:
        chunk = stream.read(size - len(chunks))
        if not chunk:
            raise ValueError("truncated Git object")
        chunks.extend(chunk)
    return bytes(chunks)


def discard_exact(stream: BinaryIO, size: int) -> None:
    remaining = size
    while remaining:
        chunk = stream.read(min(remaining, 64 * 1024))
        if not chunk:
            raise ValueError("truncated Git object")
        remaining -= len(chunk)


def iter_object_data(
    root: Path,
    object_ids: Iterable[str],
    *,
    max_artifact_bytes: int = MAX_ARTIFACT_BYTES,
) -> Iterator[tuple[str, str, bytes | None]]:
    ids = list(object_ids)
    if not ids:
        return
    process = subprocess.Popen(
        ["git", "cat-file", "--batch"],
        cwd=root,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    if process.stdin is None or process.stdout is None:
        process.kill()
        raise ValueError("could not inspect Git objects")
    try:
        for requested_id in ids:
            process.stdin.write(f"{requested_id}\n".encode("ascii"))
            process.stdin.flush()
            header = process.stdout.readline().rstrip(b"\n")
            fields = header.split()
            if len(fields) != 3 or fields[0].decode("ascii", errors="ignore") != requested_id:
                raise ValueError("invalid Git object response")
            object_type = fields[1].decode("ascii")
            size = int(fields[2])
            if size > max_artifact_bytes:
                discard_exact(process.stdout, size)
                data = None
            else:
                data = read_exact(process.stdout, size)
            if process.stdout.read(1) != b"\n":
                raise ValueError("invalid Git object delimiter")
            yield requested_id, object_type, data
        process.stdin.close()
        if process.wait() != 0:
            raise ValueError("could not inspect Git objects")
    finally:
        if not process.stdin.closed:
            process.stdin.close()
        if process.poll() is None:
            process.kill()
            process.wait()


def resolve_commit(root: Path, ref: str) -> str:
    if not ref or ref.startswith("-"):
        raise ValueError("invalid Git commit")
    object_id = run_git(root, "rev-parse", "--verify", f"{ref}^{{commit}}").decode("ascii").strip()
    if not re.fullmatch(r"(?:[0-9a-f]{40}|[0-9a-f]{64})", object_id):
        raise ValueError("invalid Git commit")
    return object_id


def resolve_tree(root: Path, tree_ish: str) -> str:
    """Peel any tree-ish to its tree object id."""
    if not tree_ish or tree_ish.startswith("-"):
        raise ValueError("invalid Git tree-ish")
    object_id = run_git(
        root,
        "rev-parse",
        "--verify",
        f"{tree_ish}^{{tree}}",
    ).decode("ascii").strip()
    if not re.fullmatch(r"(?:[0-9a-f]{40}|[0-9a-f]{64})", object_id):
        raise ValueError("invalid Git tree-ish")
    return object_id


def normalize_commit_range(root: Path, commit_range: str) -> str:
    if "..." in commit_range or commit_range.count("..") > 1:
        raise ValueError("invalid Git commit range")
    if ".." not in commit_range:
        return resolve_commit(root, commit_range)
    base_ref, head_ref = commit_range.split("..", 1)
    base_commit = resolve_commit(root, base_ref)
    head_commit = resolve_commit(root, head_ref)
    if base_commit == head_commit or not git_succeeds(
        root, "merge-base", "--is-ancestor", base_commit, head_commit
    ):
        raise ValueError("invalid Git commit range")
    return f"{base_commit}..{head_commit}"


def scan_tag_object(
    root: Path,
    ref: str,
    rules: list[PatternRule],
    findings: list[Finding],
) -> None:
    if run_git(root, "cat-file", "-t", ref).decode("ascii").strip() != "tag":
        raise ValueError("expected an annotated tag object")
    if git_object_size(root, ref) > MAX_ARTIFACT_BYTES:
        record_oversized_finding(findings, "tag-metadata", "tag metadata: ")
        return
    tag_data = run_git(root, "cat-file", "tag", ref)
    scan_tag_data(tag_data, rules, findings)


def scan_tag_data(
    tag_data: bytes,
    rules: list[PatternRule],
    findings: list[Finding],
) -> None:
    tag_text = decode_text(tag_data)
    exempt_lines, forced_lines, signature_admitted = (
        tag_message_high_entropy_policy(tag_text)
        if tag_text is not None
        else (set(), set(), None)
    )
    if signature_admitted is False:
        findings.append(Finding("FAIL", "tag-metadata", 0, "tag metadata: unverified or unsupported signature material"))
    scan_blob(
        findings,
        "tag-metadata",
        tag_data,
        rules,
        label_prefix="tag metadata: ",
        high_entropy_exempt_lines=exempt_lines,
        forced_high_entropy_lines=forced_lines,
    )


def scan_tree_objects(
    root: Path,
    tree_ish: str,
    rules: list[PatternRule],
    findings: list[Finding],
    pathset: set[str] | None = None,
) -> None:
    paths_by_object: dict[str, list[str]] = {}
    for entry in tree_entries(root, tree_ish):
        record_path_finding(findings, entry.path)
        record_allowlist_finding(findings, entry.path, pathset)
        if entry.object_type != "blob":
            findings.append(Finding("FAIL", entry.path, 0, "unsupported tracked object type"))
            continue
        paths_by_object.setdefault(entry.object_id, []).append(entry.path)

    for object_id, object_type, data in iter_object_data(root, paths_by_object):
        if object_type != "blob":
            raise ValueError("invalid Git tree object")
        for rel in paths_by_object[object_id]:
            if data is None:
                record_oversized_finding(findings, rel)
            else:
                scan_blob(findings, rel, data, rules)


def openpgp_signature_packet_is_bound(
    packet: bytes, status: bytes, payload: bytes, signer_key_bits: int | None = None,
) -> bool:
    """Admit only a complete v4 signature with bounded, verified metadata.

    GnuPG may ignore excess bytes in recognized unhashed subpackets. Its
    successful verification alone does not classify those bytes as safe.
    """
    valid = re.findall(rb"^\[GNUPG:\] VALIDSIG ([^\r\n]+)$", status, re.MULTILINE)
    if len(valid) != 1:
        return False
    verified = valid[0].split()
    if (
        len(verified) not in {9, 10}
        or re.fullmatch(rb"[0-9A-F]{40}", verified[0]) is None
        or not verified[2].isdigit()
        or verified[4:6] != [b"4", b"0"]
        or not verified[6].isdigit() or not verified[7].isdigit()
        or verified[8] != b"00"
    ):
        return False
    fingerprint = bytes.fromhex(verified[0].decode("ascii"))
    if len(packet) < 2 or not packet[0] & 0x80:
        return False
    if packet[0] & 0x40:
        if packet[0] & 0x3F != 2:
            return False
        first = packet[1]
        if first < 192:
            offset, length = 2, first
        elif first < 224 and len(packet) >= 3:
            offset, length = 3, ((first - 192) << 8) + packet[2] + 192
        elif first == 255 and len(packet) >= 6:
            offset, length = 6, int.from_bytes(packet[2:6], "big")
        else:
            return False
    else:
        if (packet[0] >> 2) & 15 != 2 or packet[0] & 3 == 3:
            return False
        width = (1, 2, 4)[packet[0] & 3]
        if len(packet) < 1 + width:
            return False
        offset, length = 1 + width, int.from_bytes(packet[1:1 + width], "big")
    if offset + length != len(packet):
        return False
    body = packet[offset:]
    if (
        len(body) < 10 or body[:2] != b"\x04\x00"
        or body[2] != int(verified[6]) or body[3] != int(verified[7])
    ):
        return False
    seen: set[int] = set()
    issuer_found = False
    cursor = 4
    hashed_end = 0
    for hashed in (True, False):
        if cursor + 2 > len(body):
            return False
        size = int.from_bytes(body[cursor:cursor + 2], "big")
        cursor += 2
        end = cursor + size
        if end > len(body):
            return False
        if hashed:
            hashed_end = end
        while cursor < end:
            # Every supported subpacket fits its canonical one-byte length.
            # Other encodings or metadata are deliberately unsupported.
            if cursor + 2 > end:
                return False
            size, kind = body[cursor], body[cursor + 1] & 0x7F
            if size != {2: 5, 16: 9, 33: 22}.get(kind) or kind in seen or cursor + 1 + size > end:
                return False
            metadata = body[cursor + 2:cursor + 1 + size]
            if kind == 2:
                if not hashed or int.from_bytes(metadata, "big") != int(verified[2]):
                    return False
            elif kind == 16:
                if metadata != fingerprint[-8:]:
                    return False
                issuer_found = True
            else:
                if not hashed or metadata != b"\x04" + fingerprint:
                    return False
                issuer_found = True
            seen.add(kind)
            cursor += 1 + size
    if 2 not in seen or not issuer_found:
        return False
    algorithm = {1: "md5", 2: "sha1", 3: "ripemd160", 8: "sha256", 9: "sha384", 10: "sha512", 11: "sha224"}.get(body[3])
    if algorithm is None or cursor + 2 > len(body):
        return False
    # GnuPG also ignores these two bytes. Bind them to the binary payload and
    # the complete hashed fields/trailer specified by the v4 packet format.
    try:
        digest = hashlib.new(
            algorithm, payload + body[:hashed_end] + b"\x04\xff" + hashed_end.to_bytes(4, "big"),
        ).digest()
    except ValueError:
        return False
    if body[cursor:cursor + 2] != digest[:2]:
        return False
    cursor += 2
    mpi_count = {1: 1, 3: 1, 17: 2, 19: 2, 22: 2}.get(body[2])
    if mpi_count is None:
        return False
    for _index in range(mpi_count):
        if cursor + 2 > len(body):
            return False
        bits = int.from_bytes(body[cursor:cursor + 2], "big")
        size = (bits + 7) // 8
        cursor += 2
        if not 0 < bits <= 16384 or cursor + size > len(body):
            return False
        actual_bits = int.from_bytes(body[cursor:cursor + size], "big").bit_length()
        if actual_bits != bits and not (
            body[2] in {1, 3} and bits == signer_key_bits and 0 < actual_bits < bits
        ):
            return False
        cursor += size
    return cursor == len(body)


def verified_signature_entropy_lines(signature_lines: list[bytes], payload: bytes) -> set[int]:
    """Classify only cryptographically verified signature bytes, not signer trust.

    Missing verification tools/keys, malformed armor and changed signed payloads
    receive no exception. Every other privacy rule still scans these lines.
    """
    signature = b"\n".join(signature_lines) + b"\n"
    pgp = re.fullmatch(
        rb"-----BEGIN PGP SIGNATURE-----\n(?:[A-Za-z][A-Za-z0-9-]*: [^\r\n]*\n)*\n"
        rb"(?:[A-Za-z0-9+/]{1,76}={0,2}\n)+(?:=[A-Za-z0-9+/]{4}\n)?"
        rb"-----END PGP SIGNATURE-----\n\n?",
        signature,
    )
    ssh = re.fullmatch(
        rb"-----BEGIN SSH SIGNATURE-----\n(?:[A-Za-z0-9+/]{1,76}={0,2}\n)+"
        rb"-----END SSH SIGNATURE-----\n",
        signature,
    )
    if not pgp and not ssh:
        return set()
    if ssh:
        try:
            packet = base64.b64decode(b"".join(signature_lines[1:-1]), validate=True)
        except binascii.Error:
            return set()
        if packet[:10] != b"SSHSIG\x00\x00\x00\x01":
            return set()
        fields: list[bytes] = []
        offset = 10
        for _index in range(5):
            if offset + 4 > len(packet):
                return set()
            length = int.from_bytes(packet[offset:offset + 4], "big")
            end = offset + 4 + length
            if end > len(packet):
                return set()
            fields.append(packet[offset + 4:end])
            offset = end
        if offset != len(packet) or fields[1] != b"git" or fields[2] or fields[3] not in {b"sha256", b"sha512"}:
            return set()
        key_type_length = int.from_bytes(fields[0][:4], "big")
        key_type = fields[0][4:4 + key_type_length]
        if key_type not in {
            b"ssh-ed25519", b"ssh-rsa", b"ecdsa-sha2-nistp256", b"ecdsa-sha2-nistp384", b"ecdsa-sha2-nistp521",
        }:
            return set()
    try:
        with tempfile.TemporaryDirectory(prefix="pp-signature-check-") as directory:
            signature_file = Path(directory) / "signature"
            signature_file.write_bytes(signature)
            command = (
                ["gpg", "--no-options", "--batch", "--no-tty",
                 "--no-auto-key-retrieve", "--no-auto-check-trustdb", "--status-fd=1",
                 "--verify", str(signature_file), "-"]
                if pgp else
                ["ssh-keygen", "-Y", "check-novalidate", "-n", "git", "-s", str(signature_file)]
            )
            result = subprocess.run(
                command, input=payload, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                check=False, timeout=10,
            )
    except (OSError, subprocess.TimeoutExpired):
        return set()
    if result.returncode != 0:
        return set()
    if pgp and not (
        re.search(rb"^\[GNUPG:\] VALIDSIG [0-9A-F]+ ", result.stdout, re.MULTILINE)
        and re.search(rb"^\[GNUPG:\] GOODSIG ", result.stdout, re.MULTILINE)
    ):
        return set()
    if pgp:
        body_start = signature_lines.index(b"") + 1
        encoded = b"".join(
            line for line in signature_lines[body_start:]
            if line and not line.startswith((b"=", b"-----END"))
        )
        try:
            packet = base64.b64decode(encoded, validate=True)
        except binascii.Error:
            return set()
        signer_key_bits = None
        valid = re.findall(rb"^\[GNUPG:\] VALIDSIG ([0-9A-F]{40}) ", result.stdout, re.MULTILINE)
        if len(valid) != 1:
            return set()
        try:
            keys = subprocess.run(
                ["gpg", "--no-options", "--batch", "--no-tty", "--no-auto-check-trustdb",
                 "--with-colons", "--fixed-list-mode", "--list-keys", valid[0].decode("ascii")],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False, timeout=10,
            )
        except (OSError, subprocess.TimeoutExpired):
            return set()
        if keys.returncode != 0:
            return set()
        current_key: list[bytes] | None = None
        for row in keys.stdout.splitlines():
            fields = row.split(b":")
            if fields[0] in {b"pub", b"sub"}:
                current_key = fields
            elif fields[0] == b"fpr" and len(fields) > 9 and fields[9] == valid[0] and current_key:
                if len(current_key) > 3 and current_key[2].isdigit() and current_key[3] in {b"1", b"3"}:
                    signer_key_bits = int(current_key[2])
        if not openpgp_signature_packet_is_bound(packet, result.stdout, payload, signer_key_bits):
            return set()
    return {line_no for line_no, line in enumerate(signature_lines, 1)
            if re.fullmatch(rb"[A-Za-z0-9+/]{1,76}={0,2}", line)}


def verified_commit_signature_entropy_lines(raw_commit: bytes, public_headers: list[bytes]) -> set[int]:
    headers, separator, message = raw_commit.partition(b"\n\n")
    if not separator:
        return set()
    signature_lines: list[bytes] = []
    unsigned_headers: list[bytes] = []
    selected = False
    signature_count = 0
    for line in headers.split(b"\n"):
        if line.startswith(b" "):
            if selected:
                signature_lines.append(line[1:])
            else:
                unsigned_headers.append(line)
            continue
        selected = line.startswith(b"gpgsig ")
        if selected:
            signature_count += 1
            signature_lines.append(line[len(b"gpgsig "):])
        else:
            unsigned_headers.append(line)
    if signature_count != 1 or not verified_signature_entropy_lines(
        signature_lines, b"\n".join(unsigned_headers) + separator + message,
    ):
        return set()
    exempt: set[int] = set()
    selected = False
    for line_no, line in enumerate(public_headers, 1):
        if not line.startswith(b" "):
            selected = line.startswith(b"gpgsig ")
        elif selected and re.fullmatch(rb" [A-Za-z0-9+/]{1,76}={0,2}", line):
            exempt.add(line_no)
    return exempt


def scan_commit_envelope(
    root: Path,
    commit: str,
    rules: list[PatternRule],
    findings: list[Finding],
    *,
    scan_identity: bool = True,
    reviewed_history: bool = False,
) -> None:
    resolved = resolve_commit(root, commit)
    short = resolved[:12]
    if git_object_size(root, resolved) > MAX_ARTIFACT_BYTES:
        record_oversized_finding(
            findings,
            f"commit-{short}-metadata",
            "commit metadata: ",
        )
        return
    raw_commit = run_git(root, "cat-file", "commit", resolved)
    raw_headers, _separator, message = raw_commit.partition(b"\n\n")
    public_headers: list[bytes] = []
    excluded_headers = {b"tree", b"parent"}
    if not scan_identity:
        excluded_headers.update({b"author", b"committer"})
    include_continuation = False
    for line in raw_headers.splitlines():
        if line.startswith(b" "):
            if include_continuation:
                public_headers.append(line)
            continue
        key = line.partition(b" ")[0]
        include_continuation = key not in excluded_headers
        if include_continuation:
            public_headers.append(line)
    signature_lines = verified_commit_signature_entropy_lines(raw_commit, public_headers)
    if any(line.startswith(b"gpgsig ") for line in public_headers) and not signature_lines:
        findings.append(Finding(
            "FAIL", f"commit-{short}-metadata", 0,
            "commit metadata: unverified or unsupported signature material",
        ))
    scan_blob(
        findings,
        f"commit-{short}-metadata",
        b"\n".join(public_headers),
        rules,
        label_prefix="commit metadata: ",
        high_entropy_exempt_lines=signature_lines,
    )
    scan_blob(
        findings,
        f"commit-{short}",
        message,
        rules,
        label_prefix="commit message: ",
        high_entropy_exempt_lines=(
            {3, 4} if re.fullmatch(
                rb"chore\(release\): v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\n\n"
                rb"source: gitea/[0-9a-f]{40}\nsource-tree: [0-9a-f]{40}\n",
                message,
            ) else set()
        ),
        reviewed_material=(
            reviewed_history_material("message", "", message, resolved)
            if reviewed_history else None
        ),
    )


def scan_publication(
    root: Path,
    tree: str | None,
    commit: str | None,
    tags: list[str],
    rules: list[PatternRule],
    findings: list[Finding],
    pathset: set[str] | None = None,
) -> None:
    if not commit:
        findings.append(Finding(
            "FAIL",
            ".",
            0,
            "publication mode requires --commit-envelope",
        ))
        return
    resolved_commit = resolve_commit(root, commit)
    published_tree = resolve_tree(root, resolved_commit)
    if tree is not None:
        supplied_tree = resolve_tree(root, tree)
        if supplied_tree != published_tree:
            findings.append(Finding(
                "FAIL",
                ".",
                0,
                "publication --tree does not match --commit-envelope tree",
            ))
            return
    scan_commit_envelope(root, resolved_commit, rules, findings, scan_identity=True)
    for tag in tags:
        scan_tag_object(root, tag, rules, findings)
    scan_tree_objects(root, published_tree, rules, findings, pathset)


def scan_ref(
    root: Path,
    ref: str,
    rules: list[PatternRule],
    findings: list[Finding],
    pathset: set[str] | None = None,
) -> None:
    object_type = run_git(root, "cat-file", "-t", ref).decode("ascii").strip()
    if object_type == "tag":
        scan_tag_object(root, ref, rules, findings)
    scan_tree_objects(root, ref, rules, findings, pathset)


def reviewed_history_material(
    surface: str,
    path: str,
    data: bytes,
    commit: str | None = None,
) -> dict | None:
    digest = hashlib.sha256(data).hexdigest()
    return next((
        material for material in REVIEWED_PUBLIC_HISTORY.get("materials", [])
        if material.get("surface") == surface
        and material.get("path") == policy_path(path)
        and material.get("sha256") == digest
        and (surface != "message" or material.get("git_commit") == commit)
    ), None)


def reviewed_history_commits(root: Path, head: str, commits: list[str]) -> set[str]:
    base = REVIEWED_PUBLIC_HISTORY.get("git_commit")
    approved = {record.get("git_commit"): record.get("sha256")
                for record in REVIEWED_PUBLIC_HISTORY.get("commits", [])}
    if not base or base not in approved or not git_succeeds(root, "merge-base", "--is-ancestor", base, head):
        return set()
    if git_object_size(root, base) > MAX_ARTIFACT_BYTES or hashlib.sha256(
        run_git(root, "cat-file", "commit", base),
    ).hexdigest() != approved[base]:
        return set()
    return {
        commit for commit in commits
        if commit in approved and git_object_size(root, commit) <= MAX_ARTIFACT_BYTES
        and hashlib.sha256(run_git(root, "cat-file", "commit", commit)).hexdigest() == approved[commit]
    }


def scan_commit_range(
    root: Path,
    commit_range: str,
    rules: list[PatternRule],
    findings: list[Finding],
    expected_ref: str | None = None,
    *,
    exempt_identity: bool = False,
    pathset: set[str] | None = None,
) -> None:
    normalized_range = normalize_commit_range(root, commit_range)
    range_head = normalized_range.rsplit("..", 1)[-1]
    if expected_ref and resolve_commit(root, expected_ref) != range_head:
        raise ValueError("Git commit range does not match ref")
    commits = run_git(root, "rev-list", "--reverse", normalized_range).decode("ascii").splitlines()
    reviewed_commits = reviewed_history_commits(root, range_head, commits)
    commits_by_short = {commit[:12]: commit for commit in commits}
    if len(commits_by_short) != len(commits):
        raise ValueError("ambiguous historical commit paths")
    for commit in commits:
        short = commit[:12]
        scan_commit_envelope(
            root,
            commit,
            rules,
            findings,
            scan_identity=not exempt_identity,
            reviewed_history=commit in reviewed_commits,
        )

        changed = run_git(
            root,
            "diff-tree",
            "--root",
            "-m",
            "--no-commit-id",
            "--name-only",
            "--no-renames",
            "-r",
            "-z",
            commit,
        )
        for rel in sorted(decode_nul_paths(changed)):
            historical_path = f"commit-{short}/{rel}"
            record_path_finding(findings, historical_path, "commit artifact: ")
            record_allowlist_finding(
                findings,
                historical_path,
                pathset,
                "commit artifact: ",
                allowlist_path=rel,
            )
            object_spec = f"{commit}:{rel}"
            if not git_succeeds(root, "cat-file", "-e", object_spec):
                continue
            object_size = git_object_size(root, object_spec)
            if object_size > MAX_ARTIFACT_BYTES and (
                commit not in reviewed_commits or object_size > MAX_REVIEWED_HISTORY_ARTIFACT_BYTES
            ):
                record_oversized_finding(findings, historical_path, "commit artifact: ")
                continue
            data = run_git(root, "show", object_spec)
            surface = "binary" if Path(rel).suffix.lower() in BINARY_EXTENSIONS else "blob"
            scan_blob(
                findings, historical_path, data, rules, label_prefix="commit artifact: ",
                reviewed_material=(
                    reviewed_history_material(surface, historical_path, data)
                    if commit in reviewed_commits else None
                ),
            )

    blob_paths: dict[str, set[str]] = {}
    for commit in commits:
        for entry in tree_entries(root, commit):
            historical_path = f"commit-{commit[:12]}/{entry.path}"
            if entry.object_type != "blob":
                findings.append(Finding(
                    "FAIL",
                    historical_path,
                    0,
                    "reachable commit artifact: unsupported tracked object type",
                ))
                continue
            blob_paths.setdefault(entry.object_id, set()).add(historical_path)

    for paths in blob_paths.values():
        for rel in paths:
            record_path_finding(findings, rel, "reachable commit artifact: ")
            record_allowlist_finding(
                findings,
                rel,
                pathset,
                "reachable commit artifact: ",
                allowlist_path=rel.split("/", 1)[1],
            )
    for object_id, object_type, data in iter_object_data(
        root, blob_paths,
        max_artifact_bytes=MAX_REVIEWED_HISTORY_ARTIFACT_BYTES if reviewed_commits else MAX_ARTIFACT_BYTES,
    ):
        if object_type != "blob":
            raise ValueError("invalid Git object inventory")
        for rel in blob_paths[object_id]:
            if data is None:
                record_oversized_finding(
                    findings,
                    rel,
                    "reachable commit artifact: ",
                )
            else:
                historical_commit = commits_by_short[rel.split("/", 1)[0].removeprefix("commit-")]
                surface = "binary" if Path(rel).suffix.lower() in BINARY_EXTENSIONS else "blob"
                scan_blob(
                    findings,
                    rel,
                    data,
                    rules,
                    label_prefix="reachable commit artifact: ",
                    reviewed_material=(
                        reviewed_history_material(surface, rel, data)
                        if historical_commit in reviewed_commits else None
                    ),
                )


def audit(args: argparse.Namespace) -> list[Finding]:
    root = Path(args.root).resolve()
    host_value = os.environ.get("PUBLIC_RELEASE_FORBIDDEN_HOSTS", "")
    host_rules = forbidden_host_rules(host_value)
    if args.require_forbidden_hosts and not host_rules:
        return [Finding("FAIL", ".", 0, "PUBLIC_RELEASE_FORBIDDEN_HOSTS is required for public release")]

    pathset = None
    if args.allowlist_pathset is not None:
        loaded_pathset, pathset_error = load_allowlist_pathset(args.allowlist_pathset)
        if pathset_error:
            return [Finding("FAIL", ".", 0, pathset_error)]
        pathset = loaded_pathset

    export_requested = args.export_tree is not None
    if export_requested and (
        args.ref or args.commit_range or args.commit_envelope or args.tree or args.tag_envelope
        or pathset is None or not args.require_forbidden_hosts or not args.fail_on_warn
    ):
        return [Finding("FAIL", ".", 0, "export mode requires pathset, forbidden-host policy and fatal warnings without publication/history overrides")]
    publication_requested = bool(
        args.commit_envelope or args.tree or args.tag_envelope or (args.tag_envelope_file and not export_requested)
    )
    if publication_requested and (args.ref or args.commit_range):
        return [Finding(
            "FAIL",
            ".",
            0,
            "publication mode cannot combine with --ref/--commit-range",
        )]
    if args.commit_envelope and not host_rules:
        return [Finding(
            "FAIL",
            ".",
            0,
            "PUBLIC_RELEASE_FORBIDDEN_HOSTS is required for public release",
        )]

    rules = list(BASE_RULES) + host_rules
    excludes = load_excludes(args.exclude)
    findings: list[Finding] = []
    try:
        if export_requested:
            with without_git_replacement_objects():
                if run_git(root, "cat-file", "-t", args.export_tree).strip() != b"tree":
                    raise ValueError("export mode requires the actual exported tree object")
                scan_tree_objects(root, args.export_tree, rules, findings, pathset)
        elif publication_requested:
            with without_git_replacement_objects():
                scan_publication(
                    root,
                    args.tree,
                    args.commit_envelope,
                    args.tag_envelope,
                    rules,
                    findings,
                    pathset,
                )
        elif args.ref:
            scan_ref(root, args.ref, rules, findings, pathset)
        else:
            files, tracked = git_files(root, args.include_untracked)
            for rel in files:
                if rel not in tracked and is_excluded(rel, excludes):
                    continue
                record_path_finding(findings, rel)
                record_allowlist_finding(findings, rel, pathset)
                path = root / rel
                try:
                    if path.is_symlink():
                        data = os.fsencode(os.readlink(path))
                    else:
                        with path.open("rb") as stream:
                            data = stream.read(MAX_ARTIFACT_BYTES + 1)
                except OSError:
                    level = "FAIL" if rel in tracked else "WARN"
                    findings.append(Finding(level, rel, 0, "could not read file"))
                    continue
                if len(data) > MAX_ARTIFACT_BYTES:
                    record_oversized_finding(findings, rel)
                else:
                    scan_blob(findings, rel, data, rules)

        for filename in args.tag_envelope_file:
            file = Path(filename)
            if file.is_symlink() or not file.is_file():
                raise ValueError("raw source tag must be a regular file")
            with file.open("rb") as stream:
                raw_tag = stream.read(MAX_ARTIFACT_BYTES + 1)
            if len(raw_tag) > MAX_ARTIFACT_BYTES or b"\n\n" not in raw_tag:
                raise ValueError("raw source tag is malformed or oversized")
            scan_tag_data(raw_tag, rules, findings)
        if args.commit_range:
            scan_commit_range(
                root,
                args.commit_range,
                rules,
                findings,
                expected_ref=args.ref,
                exempt_identity=args.exempt_source_commit_identity,
                pathset=pathset,
            )
    except (OSError, ValueError):
        findings.append(Finding("FAIL", ".", 0, "could not inspect Git ref"))
    return findings


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=".")
    parser.add_argument("--repo-name", default="local")
    parser.add_argument("--exclude", action="append", default=[], help="exclude matching untracked paths")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--fail-on-warn", action="store_true")
    parser.add_argument("--include-untracked", action="store_true")
    parser.add_argument("--require-forbidden-hosts", action="store_true")
    parser.add_argument(
        "--allowlist-pathset",
        help=(
            "path to an export provenance JSON carrying the normalized 'pathset' "
            "array and 'pathsetSha256' digest emitted by export-public-tree.mjs; "
            "every real path the gate walks must be covered by it (default-deny "
            "allowlist in front of the blocklist scanner)"
        ),
    )
    parser.add_argument("--ref", help="scan the complete tree at this Git ref instead of the working tree")
    parser.add_argument("--export-tree", help="scan pre-publication E with mandatory provenance, forbidden hosts and fatal warnings")
    parser.add_argument("--commit-range", help="scan messages and changed blobs for every commit in RANGE")
    parser.add_argument(
        "--exempt-source-commit-identity",
        action="store_true",
        help="skip author and committer identity scanning for a source-only commit range",
    )
    parser.add_argument(
        "--commit-envelope",
        help=(
            "scan message + public headers of published commit P (required for "
            "publication mode; the scanned tree is derived from P, no history walk)"
        ),
    )
    parser.add_argument(
        "--tree",
        help="optional cross-check tree-ish ($TREE_S); FAILs unless == commit-envelope^{tree}",
    )
    parser.add_argument(
        "--tag-envelope",
        action="append",
        default=[],
        help="scan an annotated-tag object message of P (repeatable for multiple public tags)",
    )
    parser.add_argument(
        "--tag-envelope-file",
        action="append",
        default=[],
        help="scan a raw source tag outside the isolated consumer Git object database",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    findings = audit(args)
    if args.json:
        print(json.dumps([finding.as_public_dict() for finding in findings], indent=2, ensure_ascii=False))
    elif findings:
        for finding in findings:
            print(finding.as_text(args.repo_name))
    else:
        print("OK - no public-release privacy findings.")
    if any(finding.level == "FAIL" for finding in findings):
        return 1
    if args.fail_on_warn and any(finding.level == "WARN" for finding in findings):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
