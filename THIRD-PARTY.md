# Сторонние компоненты

liber.net распространяется под лицензией MIT (см. [LICENSE](LICENSE)) и включает перечисленные ниже сторонние компоненты.

## byedpi — движок обхода блокировок

| | |
|---|---|
| Файл | `engine/ciadpi.exe` |
| Автор | hufrea |
| Источник | <https://github.com/hufrea/byedpi> |
| Лицензия | MIT |

Текст лицензии приведён ниже. Он также поставляется вместе с приложением в файле `resources/engine/LICENSE.byedpi.txt` — это обязательное условие лицензии MIT при распространении бинарного файла.

```text
MIT License

Copyright (c) 2024 hufrea

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

## Electron и Chromium

Оболочка приложения — Electron, ядро рендеринга — Chromium. Тексты лицензий этих компонентов включаются в сборку автоматически и лежат в каталоге установки рядом с `liber.net.exe`:

- `LICENSE.electron.txt` — лицензия Electron (MIT);
- `LICENSES.chromium.html` — лицензии Chromium и входящих в него компонентов.
