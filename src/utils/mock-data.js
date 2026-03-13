/**
 * Mock Data Module
 * Contains sample data for random test generation
 */

const path = require('path');

const NAMES = ['Alex', 'Bella', 'Charlie', 'Kitty', 'Test User', 'William', 'Emma', 'Luna'];
const PET_NAMES = ['Buddy', 'Max', 'Kitty', 'Luna', 'Coco', 'Milo', 'Bella', 'Daisy'];
const YEARS = Array.from({ length: 11 }, (_, i) => String(2015 + i));

const SAMPLE_IMAGES = [
    path.resolve(__dirname, '../../assets/test-cat.png'),
    path.resolve(__dirname, '../../assets/test-dog.png'),
];

function pickRandom(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function getRandomName() {
    return pickRandom(NAMES);
}

function getRandomPetName() {
    return pickRandom(PET_NAMES);
}

function getRandomYear() {
    return pickRandom(YEARS);
}

function getRandomImage() {
    return pickRandom(SAMPLE_IMAGES);
}

function getRandomString(length = 8) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

module.exports = {
    NAMES,
    PET_NAMES,
    YEARS,
    SAMPLE_IMAGES,
    pickRandom,
    getRandomName,
    getRandomPetName,
    getRandomYear,
    getRandomImage,
    getRandomString,
};
