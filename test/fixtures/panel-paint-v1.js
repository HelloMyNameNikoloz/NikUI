  function paint(el, item) {
    switch (item.kind) {
      case 'user': {
        el.className = 'turn-user';
        let html = '<div class="said">' + esc(item.text) + '</div>';
        if (item.snippets && item.snippets.length) {
          html += '<div class="used-snippets">' + item.snippets.map(function (name) {
            return '<span class="snippet-chip" title="' +
              esc(snippetText[name] || 'A standing instruction was added to this prompt.') +
              '">+' + esc(name) + '</span>';
          }).join('') + '</div>';
        }
        if (item.images && item.images.length) {
          // Width/height are rarely known ahead of decoding, so most shots
          // get a placeholder box instead (panel.css) -- dropped on load,
          // so the transcript does not jump by the image's height right as
          // it appears.
          html += '<div class="shots">' + item.images.map(function (im) {
            const known = im.width && im.height;
            const dims = known ? ' width="' + im.width + '" height="' + im.height + '"' : ' class="loading"';
            return '<img src="data:' + esc(im.mediaType) + ';base64,' + im.data + '" alt="' + esc(im.name || 'image') + '"' + dims + '>';
          }).join('') + '</div>';
        }
        html += clockTag(item.at, 'sent-at', 'Sent');
        el.innerHTML = html;
        el.querySelectorAll('.shots img.loading').forEach(function (img) {
          img.addEventListener('load', function () { img.classList.remove('loading'); }, { once: true });
        });
        break;
      }

      case 'text':
        el.className = 'msg-text';
        el.innerHTML = window.renderMarkdown(item.text || '');
        break;

      case 'thinking': {
        el.className = 'thinking';
        // Signature-only thinking blocks carry no text; do not show an empty disclosure.
        el.hidden = !showThinking || !(item.text || '').trim();
        const open = el.querySelector('details') && el.querySelector('details').open;
        el.innerHTML = '<details' + (open ? ' open' : '') + '><summary>' + icon('sparkles', 12) +
          'Thinking</summary><div class="body">' + esc(item.text) + '</div></details>';
        break;
      }

      case 'tool': {
        // Running means running. Anything else is finished, one way or another:
        // a result, an error, or a turn that ended without either.
        const running = item.status === 'running';
        const abandoned = item.status === 'stopped';
        el.className = 'tool' + (item.isError ? ' err' : '');
        const details = el.querySelector('details');
        const open = details ? details.open : false;
        const mark = running ? '<span class="spinner"></span>'
          : (item.isError ? '<span class="cross">' + icon('alert', 13) + '</span>'
            : abandoned ? '<span class="cross" title="This tool never reported back — the turn ended first.">' +
                icon('alert', 13) + '</span>'
              : '<span class="tick">' + icon('check', 13) + '</span>');
        let body = '<div class="label">Input</div><pre>' + esc(pretty(item.input)) + '</pre>';
        if (item.result !== undefined && item.result !== '') {
          body += '<div class="label">' + (item.isError ? 'Error' : 'Result') + '</div><pre>' + esc(item.result) + '</pre>';
          if (item.resultClipped) {
            body += '<div class="clipped">' + esc('Showing the first ' + fmtBytes(item.result.length) +
              ' of ' + fmtBytes(item.resultLength) + '. Claude was given all of it; the whole output is in the transcript.') + '</div>';
          }
        }
        el.innerHTML = '<details' + (open ? ' open' : '') + '><summary>' +
          '<span class="disc">' + icon('chevron', 12) + '</span>' +
          '<span class="state">' + mark + '</span>' +
          '<span class="name">' + esc(item.name) + '</span>' +
          '<span class="summary-text">' + esc(summarise(item.input)) + '</span></summary>' +
          '<div class="body">' + body + '</div></details>';
        break;
      }

      case 'permission': {
        el.className = 'perm';
        if (item.resolved) {
          el.innerHTML = '<h4>' + esc(item.name) + '</h4><div class="result">' +
            (item.resolved === 'allow' ? 'Allowed' : 'Denied') + '</div>';
        } else {
          const preview = IN_APP && item.input && item.input.command
            ? '<pre class="permission-command">' + esc(item.input.command) + '</pre><details class="permission-arguments"><summary>Arguments</summary><pre>' + esc(pretty(item.input)) + '</pre></details>'
            : '<pre>' + esc(pretty(item.input)) + '</pre>';
          el.innerHTML = '<h4>Allow ' + esc(item.name) + '?</h4>' + preview +
            '<div class="actions"><button data-act="allow">Allow</button>' +
            '<button class="ghost" data-act="deny">Deny</button></div>';
          el.querySelectorAll('button').forEach(function (b) {
            b.addEventListener('click', function () {
              if (window.NikHaptic) window.NikHaptic('medium');
              vscode.postMessage({ type: 'permission', requestId: item.requestId, allow: b.dataset.act === 'allow' });
            });
          });
        }
        break;
      }

      case 'result': {
        el.className = 'result' + (item.isError ? ' err' : '');
        const bits = [];
        if (item.interrupted) bits.push('Interrupted');
        else if (item.isError) bits.push(item.text || 'Error');
        else bits.push('Done');
        if (item.durationMs) bits.push(fmtDuration(item.durationMs));
        if (item.costUsd) bits.push('$' + item.costUsd.toFixed(4));
        el.innerHTML = bits.map((b) => '<span>' + esc(b) + '</span>').join('') +
          clockTag(item.at, 'received-at', 'Received');
        break;
      }

      case 'compact': {
        el.className = 'compacted';
        const before = item.before ? fmtBytes(item.before).replace(' characters', '') : '';
        el.innerHTML = '<span class="compacted-line"></span>' +
          '<span class="compacted-text">' +
          esc(item.trigger === 'manual' ? 'Compacted here' : 'Compacted here automatically') +
          esc(item.before ? ' · the context had reached ' + Math.round(item.before / 1000) + 'k tokens' : '') +
          '</span><span class="compacted-line"></span>';
        el.title = 'Everything above this line is still here for you to read, but the model now has ' +
          'only a summary of it. Anything below is what it can actually see.';
        break;
      }

      case 'notice':
        el.className = 'notice' + (item.level === 'error' || item.level === 'stderr' ? ' error' : '');
        el.innerHTML = '<span class="notice-text">' + esc(item.text) + '</span>' + clockTag(item.at, 'notice-at', 'At');
        break;

      default:
        el.className = 'notice';
        el.textContent = JSON.stringify(item);
    }
  }

