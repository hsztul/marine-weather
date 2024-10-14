const API_URL = 'https://forecast.weather.gov/product.php?site=NWS&issuedby=OKX&product=CWF&format=CI&version=1&highlight=on&glossary=1';

let forecastData = [];

async function fetchForecast() {
    try {
        const response = await fetch(API_URL);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const html = await response.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const forecastElement = doc.querySelector('#proddiff');
        if (!forecastElement) {
            throw new Error('Could not find forecast element in the response');
        }
        const forecastContent = forecastElement.textContent;
        return parseForecast(forecastContent);
    } catch (error) {
        console.error('Error fetching forecast:', error);
        throw error;
    }
}

function parseForecast(content) {
    const zones = content.split('$$').filter(zone => zone.trim() !== '');
    return zones.map(parseZone).filter(zone => zone !== null);
}

function parseZone(zoneContent) {
    const lines = zoneContent.trim().split('\n');
    const zoneRegex = /^ANZ\d{3}-\d{6}-$/;
    
    if (lines.length < 3 || !zoneRegex.test(lines[0])) {
        console.warn('Invalid zone format:', zoneContent);
        return null;
    }

    const zone = {
        id: lines[0].trim(),
        name: lines[1].trim(),
        updateTime: lines[2].trim(),
        advisory: '',
        forecast: []
    };

    let currentDay = '';
    let forecastText = '';

    for (let i = 3; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('...')) {
            zone.advisory = line;
        } else if (line.startsWith('.')) {
            if (currentDay) {
                zone.forecast.push({ day: currentDay, details: forecastText.trim() });
                forecastText = '';
            }
            currentDay = line.split('...')[0].replace('.', '').trim();
            forecastText = line.split('...')[1] ? line.split('...')[1].trim() + ' ' : '';
        } else if (currentDay) {
            forecastText += line + ' ';
        }
    }

    if (currentDay) {
        zone.forecast.push({ day: currentDay, details: forecastText.trim() });
    }

    return zone;
}

function renderZoneNav(zones) {
    const navElement = document.getElementById('zone-nav');
    const defaultZoneIndex = zones.findIndex(zone => zone.name.startsWith("Long Island Sound West of New Haven"));
    
    navElement.innerHTML = `
        <select id="zone-select" class="w-full p-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
            ${zones.map((zone, index) => `
                <option value="${index}" ${index === defaultZoneIndex ? 'selected' : ''}>
                    ${zone.name}
                </option>
            `).join('')}
        </select>
    `;

    document.getElementById('zone-select').addEventListener('change', (e) => {
        showZone(parseInt(e.target.value));
    });

    // Show the default zone
    showZone(defaultZoneIndex !== -1 ? defaultZoneIndex : 0);
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
                <h3 class="text-xl font-semibold mb-2 uppercase">${day.day}</h3>
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
        
        if (forecastData.length === 0) {
            throw new Error('No forecast data found');
        }

        document.getElementById('loading').classList.add('hidden');
        document.getElementById('forecast-container').classList.remove('hidden');

        renderZoneNav(forecastData);
    } catch (error) {
        console.error('Error in init:', error);
        document.getElementById('loading').classList.add('hidden');
        document.getElementById('error').classList.remove('hidden');
        document.getElementById('error').textContent = `Failed to load forecast: ${error.message}. Please try again later.`;
    }
}

init();