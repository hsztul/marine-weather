const API_URL = 'https://forecast.weather.gov/product.php?site=NWS&issuedby=OKX&product=CWF&format=CI&version=1&highlight=on&glossary=1';

let forecastData = [];

async function fetchForecast() {
    try {
        const response = await fetch(API_URL);
        const html = await response.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const forecastContent = doc.querySelector('#proddiff').textContent;
        return parseForecast(forecastContent);
    } catch (error) {
        console.error('Error fetching forecast:', error);
        throw error;
    }
}

function parseForecast(content) {
    const zones = content.split('$$').filter(zone => zone.trim() !== '');
    return zones.map(parseZone);
}

function parseZone(zoneContent) {
    const lines = zoneContent.trim().split('\n');
    const zoneRegex = /^ANZ\d{3}-\d{6}-$/;
    const zone = {
        id: '',
        name: '',
        updateTime: '',
        advisory: '',
        forecast: []
    };

    let currentDay = '';
    let forecastText = '';

    lines.forEach((line, index) => {
        if (index === 0 && zoneRegex.test(line)) {
            zone.id = line.trim();
        } else if (index === 1) {
            zone.name = line.trim();
        } else if (index === 2) {
            zone.updateTime = line.trim();
        } else if (line.startsWith('...')) {
            zone.advisory = line.trim();
        } else if (line.startsWith('.')) {
            if (currentDay) {
                zone.forecast.push({ day: currentDay, details: forecastText.trim() });
                forecastText = '';
            }
            currentDay = line.split('...')[1].split('.')[0].trim();
            forecastText += line.split('...')[1].trim() + ' ';
        } else if (currentDay) {
            forecastText += line.trim() + ' ';
        }
    });

    if (currentDay) {
        zone.forecast.push({ day: currentDay, details: forecastText.trim() });
    }

    return zone;
}

function renderZoneNav(zones) {
    const navElement = document.getElementById('zone-nav');
    navElement.innerHTML = zones.map((zone, index) => `
        <button class="px-4 py-2 m-1 bg-blue-500 text-white rounded hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-opacity-50" 
                onclick="showZone(${index})">
            ${zone.name}
        </button>
    `).join('');
}

function showZone(index) {
    const zone = forecastData[index];
    const forecastElement = document.getElementById('zone-forecast');
    forecastElement.innerHTML = `
        <h2 class="text-2xl font-semibold mb-2">${zone.name}</h2>
        <p class="text-sm text-gray-600 mb-2">Last updated: ${zone.updateTime}</p>
        ${zone.advisory ? `<p class="text-red-500 mb-4">${zone.advisory}</p>` : ''}
        ${zone.forecast.map(day => `
            <div class="mb-4">
                <h3 class="text-xl font-semibold mb-2 capitalize">${day.day}</h3>
                <p class="whitespace-pre-wrap">${day.details}</p>
            </div>
        `).join('')}
    `;
}

async function init() {
    try {
        document.getElementById('loading').classList.remove('hidden');
        document.getElementById('error').classList.add('hidden');
        document.getElementById('forecast-container').classList.add('hidden');

        forecastData = await fetchForecast();
        
        document.getElementById('loading').classList.add('hidden');
        document.getElementById('forecast-container').classList.remove('hidden');

        renderZoneNav(forecastData);
        showZone(0);
    } catch (error) {
        document.getElementById('loading').classList.add('hidden');
        document.getElementById('error').classList.remove('hidden');
        document.getElementById('error').textContent = 'Failed to load forecast. Please try again later.';
    }
}

init();