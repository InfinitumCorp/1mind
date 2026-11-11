# Third-Party Notices

1MIND can fetch two routing datasets. The binaries are not vendored in this repository. `npm run geo:fetch` downloads the pinned releases into `data/geo/` after checking each official `.sha256sum` asset against `data/geo/lock.json`.

These notices cover those datasets only. Loyalsoldier and sing-box geo data are not used.

## geoip.dat

- Project: [v2fly/geoip](https://github.com/v2fly/geoip)
- Release tag: `202611080027`
- Asset: `geoip.dat`
- URL: https://github.com/v2fly/geoip/releases/download/202611080027/geoip.dat
- SHA-256: `eedb24b3b9fcba27e06b92c0428dab90d9496083091ae4cf39e11387fd99d0e2`
- License: [Creative Commons Attribution-ShareAlike 4.0 International (CC-BY-SA-4.0)](https://creativecommons.org/licenses/by-sa/4.0/)
- Copyright: v2fly/geoip contributors

The v2fly geoip project states that it is licensed under CC-BY-SA-4.0, and that the free IP geolocation data by [DB-IP](https://db-ip.com) is licensed under [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/).

Attribution: this optional dataset includes IP geolocation data by DB-IP, licensed under CC-BY-4.0, redistributed by the v2fly geoip project under CC-BY-SA-4.0. If you adapt the dataset, share the adaptation under CC-BY-SA-4.0 and keep this attribution.

## geosite.dat

- Project: [v2fly/domain-list-community](https://github.com/v2fly/domain-list-community)
- Release tag: `20261108011013`
- Upstream asset: `dlc.dat` (saved locally as `geosite.dat`)
- URL: https://github.com/v2fly/domain-list-community/releases/download/20261108011013/dlc.dat
- SHA-256: `dc4192dd1b644a38276ed06136d26e729fa674d25785adb38c87e040e92376b2`
- License: MIT
- Copyright (c) 2018-2019 V2Ray

```
MIT License

Copyright (c) 2018-2019 V2Ray

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
