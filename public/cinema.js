(() => {
  'use strict';

  const grid = document.getElementById('seats');
  const status = document.getElementById('seat-status');
  const clearButton = document.getElementById('clear-seat');
  const lightsButton = document.getElementById('lights-toggle');
  const lightState = document.getElementById('light-state');
  const rowNames = ['A', 'B', 'C', 'D', 'E'];
  const columnCount = 5;
  const seats = [];
  let selectedSeat = null;

  function setTabStop(seat) {
    for (const button of seats) button.tabIndex = button === seat ? 0 : -1;
  }

  function selectSeat(seat) {
    const nextSeat = selectedSeat === seat ? null : seat;
    if (selectedSeat) selectedSeat.setAttribute('aria-pressed', 'false');
    selectedSeat = nextSeat;
    if (selectedSeat) {
      selectedSeat.setAttribute('aria-pressed', 'true');
      status.textContent = `${selectedSeat.dataset.row}열 ${selectedSeat.dataset.column}번 · 나만의 자리`;
    } else {
      status.textContent = '마음에 드는 자리를 골라보세요';
    }
    clearButton.disabled = selectedSeat === null;
  }

  rowNames.forEach((rowName, rowIndex) => {
    const row = document.createElement('div');
    row.className = 'seat-row';
    row.setAttribute('role', 'row');
    row.setAttribute('aria-rowindex', String(rowIndex + 1));
    row.setAttribute('aria-label', `${rowName}열`);

    const label = document.createElement('span');
    label.className = 'row-label';
    label.textContent = rowName;
    label.setAttribute('aria-hidden', 'true');
    row.append(label);

    for (let column = 1; column <= columnCount; column += 1) {
      const cell = document.createElement('div');
      cell.className = 'seat-cell';
      cell.setAttribute('role', 'gridcell');
      cell.setAttribute('aria-colindex', String(column));

      const seat = document.createElement('button');
      seat.type = 'button';
      seat.className = 'seat';
      seat.dataset.row = rowName;
      seat.dataset.column = String(column);
      seat.setAttribute('aria-label', `${rowName}열 ${column}번 좌석`);
      seat.setAttribute('aria-pressed', 'false');
      seat.tabIndex = seats.length === 0 ? 0 : -1;
      seat.innerHTML = `<span class="seat__cushion" aria-hidden="true"></span><span class="seat__back" aria-hidden="true"><span class="seat__number">${String(column).padStart(2, '0')}</span></span><span class="seat__arm seat__arm--left" aria-hidden="true"></span><span class="seat__arm seat__arm--right" aria-hidden="true"></span>`;
      seat.addEventListener('focus', () => setTabStop(seat));
      seat.addEventListener('click', () => {
        setTabStop(seat);
        selectSeat(seat);
      });
      seats.push(seat);
      cell.append(seat);
      row.append(cell);
    }
    grid.append(row);
  });

  grid.addEventListener('keydown', (event) => {
    const index = seats.indexOf(event.target);
    if (index < 0 || event.altKey || event.metaKey) return;
    const row = Math.floor(index / columnCount);
    const column = index % columnCount;
    let nextIndex = index;

    switch (event.key) {
      case 'ArrowLeft': nextIndex = row * columnCount + Math.max(0, column - 1); break;
      case 'ArrowRight': nextIndex = row * columnCount + Math.min(columnCount - 1, column + 1); break;
      case 'ArrowUp': nextIndex = Math.max(0, row - 1) * columnCount + column; break;
      case 'ArrowDown': nextIndex = Math.min(rowNames.length - 1, row + 1) * columnCount + column; break;
      case 'Home': nextIndex = event.ctrlKey ? 0 : row * columnCount; break;
      case 'End': nextIndex = event.ctrlKey ? seats.length - 1 : row * columnCount + columnCount - 1; break;
      default: return;
    }

    event.preventDefault();
    setTabStop(seats[nextIndex]);
    seats[nextIndex].focus({ preventScroll: true });
  });

  clearButton.addEventListener('click', () => {
    if (!selectedSeat) return;
    const previousSeat = selectedSeat;
    selectSeat(previousSeat);
    setTabStop(previousSeat);
    previousSeat.focus({ preventScroll: true });
  });

  lightsButton.disabled = false;
  lightsButton.addEventListener('click', () => {
    const dimmed = document.body.classList.toggle('lights-dimmed');
    lightsButton.setAttribute('aria-pressed', String(dimmed));
    lightState.textContent = dimmed ? '스크린과 통로의 빛만' : '따뜻한 실내 조명';
  });
})();
