import puppeteer from 'puppeteer';
import dotenv from 'dotenv'
import fs from 'fs';
import inquirer from "inquirer";
import axios from "axios";
import TelegramBot from "node-telegram-bot-api"

const firstStepURL = 'https://armenia.blsspainvisa.com/book_appointment.php';
const secondStepURL = 'https://armenia.blsspainvisa.com/appointment.php';
const captchaURL = "https://armenia.blsspainvisa.com/captcha/captcha.php";

global.taskID = 0;
global.cpatchaReslove = "";

(async () => {
    dotenv.config()

    const browser = await puppeteer.launch({
        headless: false
    });
    const userCookies = await getCookie(process.env.USER_MAIL)
    const page = await browser.newPage();
    page.on('dialog', async dialog => {
        console.log(dialog.message());
        await dialog.accept();
    })
    if (!userCookies) {
        console.log("cookies not found, start from initial registration")
        await page.goto(firstStepURL);

        // first select
        await page.select('#centre', process.env.CENTRE);
        await page.waitForFunction(() => document.querySelector('#category').length > 1);
        // second select
        await page.select('#category', process.env.CATEGORY);

        await page.focus('#email');
        await page.keyboard.type(process.env.USER_MAIL);
        await page.focus('#phone');
        await page.keyboard.type(process.env.USER_PHONE);

        // OTP TMP DISABLED
        // await page.evaluate(() => {
        //     document.querySelector('input[type=submit]').click();
        // });
        // const mailCodeContainer = await inquirer.prompt([
        //     {
        //         type: 'input',
        //         name: 'name',
        //         message: "Enter code from mail:",
        //     },
        // ])
        //
        // await page.focus('#otp');
        // await page.keyboard.type(mailCodeContainer.name);
        await Promise.all([
            page.click("input[value=Continue]"),
            page.waitForNavigation({waitUntil: 'networkidle2'})
        ]);

        console.log("response done")
        await page.click('button[value="Agree"]')
        const cookies = await page.cookies();
        await setCookie(process.env.USER_MAIL, cookies)
        console.log("cookies saved")
    }
    await page.waitForTimeout(3000)
    const userCookiesStep = await getCookie(process.env.USER_MAIL)
    page.on('response', async (response) => {
        if (response.url() === captchaURL) {
            const buffer = await response.buffer();
            fs.writeFileSync(`cookies/${process.env.USER_MAIL}_image.jpeg`, buffer, 'base64');
            sendPhotoTelegram();
        }
    });

    await page.setCookie(...userCookiesStep);
    await page.goto(secondStepURL, {waitUntil: "load"});

    await page.click("#app_date")
    const elHandleArray = await page.$$('td.day.activeClass')
    console.log(`found available days: ${elHandleArray.length}`)
    if (elHandleArray.length === 0) {
        console.log("no free days")
        process.exit(0)
    }
    notifyTelegram()
    if (elHandleArray.length > 0) {
        await elHandleArray[0].click()
        await page.waitForNavigation() // wait for page reload
    }
    sendCaptchaRecognize();

    await page.select('#VisaTypeId', process.env.VISA_TYPE);
    //await page.focus('#app_time'); // time range
   // await page.keyboard.press('ArrowDown');
   // await page.keyboard.press('Enter');
    // set personal data
    await (await page.waitForSelector('#first_name')).type(process.env.USER_FIRST_NAME);
    await (await page.waitForSelector('#last_name')).type(process.env.USER_LAST_NAME);

    await page.select('#nationalityId', process.env.USER_NATION);
    await page.select('#passportType', process.env.USER_PASS_TYPE);

    await page.evaluate((issuetAt, expiresAt, birthDate) => {
        document.querySelector('#pptIssueDate').value = issuetAt;
        document.querySelector('#pptExpiryDate').value = expiresAt;
        document.querySelector('#dateOfBirth').value = birthDate;
    }, process.env.USER_PASS_ISSUED_AT, process.env.USER_PASS_EXPIRES_AT, process.env.USER_BIRTH);

    await (await page.waitForSelector('#passport_no')).type(process.env.USER_PASS_NUM);
    await (await page.waitForSelector('#pptIssuePalace')).type(process.env.USER_PASS_ISSUED);

    // wait until captcha image loaded
    function waitForChange() {
        return new Promise(resolve => {
            setInterval(() => {
                if (global.cpatchaReslove !== "") {
                    resolve();
                }
            }, 1000);
        });
    }
    await waitForChange()

    await page.focus('#captcha');
    await page.keyboard.type(global.cpatchaReslove);

    await Promise.all([
        page.click("input[type=submit]"),
        page.waitForNavigation({waitUntil: 'networkidle2'})
    ]);

    const pdf = await page.pdf({ format: 'A4' });
    await fs.writeFileSync(`cookies/${process.env.USER_MAIL}_receipt.pdf`, pdf)
    await sendReceiptFileTelegram()
    //await browser.close()
})();

async function getCookie(mail) {
    try {
        const cookiesString = await fs.readFileSync(`cookies/${mail}.json`)
        const cookies = JSON.parse(cookiesString);
        return cookies
    } catch (error) {
        return undefined
    }
}

async function setCookie(mail, cookies) {
    await fs.writeFileSync(`cookies/${mail}.json`, JSON.stringify(cookies, null, 2));
}

async function sendReceiptFileTelegram() {
    const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, {polling: false});
    await bot.sendDocument(process.env.TELEGRAM_CHAT, `cookies/${process.env.USER_MAIL}_receipt.pdf`);
}

async function sendPhotoTelegram() {
    const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, {polling: false});
    await bot.sendPhoto(process.env.TELEGRAM_CHAT, `cookies/${process.env.USER_MAIL}_image.jpeg`);
}

async function notifyTelegram() {
    const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, {polling: false});
    await bot.sendMessage(process.env.TELEGRAM_CHAT, "found slot to embassy");
}

async function sendCaptchaRecognize() {
    const formData = new FormData();
    formData.append('method', 'base64');
    formData.append('key', process.env.RU_CAPTCHA_KEY);
    formData.append('body', fs.readFileSync(`cookies/${process.env.USER_MAIL}_image.jpeg`, {encoding: 'base64'}));
    axios.post('http://rucaptcha.com/in.php', formData).then(response => {
        console.log("res:",response.data);
        global.taskID = response.data.split('|')[1]
    }).catch(error => {
        console.error("err: ",error);
    });

    const inte = setInterval(async () => {
        const response = await axios.get(`http://rucaptcha.com/res.php?key=${process.env.RU_CAPTCHA_KEY}&action=get&id=${global.taskID}`)
        console.log("response", response.data)
        if (response.data !== "CAPCHA_NOT_READY") {
            global.cpatchaReslove = response.data.split('|')[1]
            clearInterval(inte)
        }
    }, 3000)
}