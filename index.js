// index.js (Restaurado a la funcionalidad de Pedidos y Asesor)

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { twiml } = require('twilio');
const appsheet = require('./appsheet');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const userSessions = {};

app.post('/whatsapp', async (req, res) => {
    const { MessagingResponse } = twiml;
    const twimlResponse = new MessagingResponse();
    
    const incomingMsg = req.body.Body.trim();
    const from = req.body.From;

    let session = userSessions[from];
    if (!session) {
        session = initializeSession(from);
        userSessions[from] = session;
    }

    const normalizedInput = incomingMsg.toLowerCase();
    console.log(`[CONVO LOG] User: ${from} | Message: "${incomingMsg}" | State: ${session.state}`);

    try {
        if (normalizedInput === 'menu' && session.state !== 'AWAITING_START') {
            sendWelcomeMenu(twimlResponse);
            session.state = 'AWAITING_MAIN_MENU_SELECTION';
            res.type('text/xml').send(twimlResponse.toString());
            return;
        }

        switch (session.state) {
            case 'AWAITING_START':
                sendWelcomeMenu(twimlResponse);
                session.state = 'AWAITING_MAIN_MENU_SELECTION';
                break;

            case 'AWAITING_MAIN_MENU_SELECTION':
                await handleMainMenuSelection(normalizedInput, session, twimlResponse);
                break;

            // --- Flujo de Pedido ---
            case 'AWAITING_NAME':
                session.order.cliente = incomingMsg;
                twimlResponse.message('Gracias. Ahora, por favor, indícame tu *dirección de entrega*.');
                session.state = 'AWAITING_ADDRESS';
                break;

            case 'AWAITING_ADDRESS':
                session.order.direccion = incomingMsg;
                twimlResponse.message('Perfecto. Por último, tu *número de celular*.');
                session.state = 'AWAITING_PHONE';
                break;

            case 'AWAITING_PHONE':
                session.order.celular = incomingMsg;
                twimlResponse.message('¡Datos guardados! \n\nAhora, dime ¿qué *producto* estás buscando?');
                session.state = 'AWAITING_PRODUCT';
                break;

            case 'AWAITING_PRODUCT':
                if (normalizedInput === 'fin' || normalizedInput === 'finalizar') {
                    await handleFinalizeOrder(session, twimlResponse);
                    delete userSessions[from];
                } else {
                    await handleProductSearch(incomingMsg, session, twimlResponse);
                }
                break;
            
            case 'AWAITING_PRODUCT_CHOICE':
                await handleProductChoice(incomingMsg, session, twimlResponse);
                break;

            case 'AWAITING_QUANTITY':
                await handleQuantity(incomingMsg, session, twimlResponse);
                break;

            case 'AWAITING_ANOTHER_FROM_LIST':
                if (normalizedInput === 'si') {
                    let message = 'Perfecto. Aquí está la lista de nuevo. Por favor, elige un número:\n\n';
                    session.tempProductMatches.forEach((p, index) => {
                        message += `*${index + 1}.* ${p.nombreProducto} - $${p.valor}\n`;
                    });
                    twimlResponse.message(message);
                    session.state = 'AWAITING_PRODUCT_CHOICE';
                } else if (normalizedInput === 'no') {
                    twimlResponse.message('Entendido. Escribe el nombre de otro producto que desees buscar, o escribe *FIN* para completar tu pedido.');
                    session.state = 'AWAITING_PRODUCT';
                    session.tempProductMatches = [];
                } else {
                    twimlResponse.message('Por favor, responde solo *SI* o *NO*.');
                }
                break;

            default:
                twimlResponse.message('Parece que nos perdimos un poco. No te preocupes, empecemos de nuevo. Escribe *Hola* para ver las opciones.');
                delete userSessions[from];
                break;
        }
    } catch (error) {
        console.error('[FATAL ERROR] Error en el webhook:', error);
        twimlResponse.message('Lo siento, ocurrió un error inesperado. Por favor, intenta de nuevo en un momento.');
        delete userSessions[from];
    }
    
    res.type('text/xml').send(twimlResponse.toString());
});


// --- Funciones Auxiliares ---

function initializeSession(from) {
    console.log(`[SESSION] Inicializando nueva sesión para ${from}`);
    return {
        from: from,
        state: 'AWAITING_START',
        order: {
            pedidoid: Date.now().toString(),
            cliente: '',
            direccion: '',
            celular: '',
            items: [],
            total: 0,
            fecha: new Date().toISOString().split('T')[0]
        },
        tempProductMatches: [],
        tempSelectedItem: null
    };
}

// Menú simplificado con solo 2 opciones
function sendWelcomeMenu(twimlResponse) {
    const message = `¡Hola! 😄 Te damos una cordial bienvenida a *Occiquimicos*.\n\nEstoy aquí para ayudarte. ¿Qué te gustaría hacer hoy?\n\n*1.* 🛍️ Realizar un pedido\n*2.* 🧑‍💼 Hablar con un asesor\n\nPor favor, responde con el *número* de la opción que elijas.`;
    twimlResponse.message(message);
}

async function handleMainMenuSelection(selection, session, twimlResponse) {
    switch (selection) {
        case '1':
            twimlResponse.message('¡Excelente! Iniciemos con tu pedido. Para comenzar, por favor, dime tu *nombre completo*.');
            session.state = 'AWAITING_NAME';
            break;
        case '2':
            const asesorNumber = process.env.WHATSAPP_ASESOR;
            if (asesorNumber) {
                const link = `https://wa.me/${asesorNumber}?text=Hola,%20necesito%20ayuda.`;
                twimlResponse.message(`Con gusto. Para hablar directamente con un asesor, por favor haz clic en el siguiente enlace:\n\n${link}\n\nSerás redirigido a su chat. ¡Que tengas un buen día!`);
            } else {
                twimlResponse.message('Lo siento, no tenemos un asesor disponible en este momento. Por favor, intenta más tarde.');
            }
            delete userSessions[session.from];
            break;
        default:
            twimlResponse.message('Opción no válida. Por favor, elige un número del *1 al 2*.');
            break;
    }
}

// --- Funciones del Flujo de Pedido ---

async function handleProductSearch(productName, session, twimlResponse) {
    const products = await appsheet.findProducts(productName);
    if (!products || products.length === 0) {
        twimlResponse.message(`No encontré productos que coincidan con "*${productName}*". Intenta con otro nombre o escribe *FIN* para cerrar el pedido.`);
        return;
    }
    if (products.length === 1) {
        session.tempSelectedItem = products[0];
        twimlResponse.message(`Encontré: *${products[0].nombreProducto}* (Valor: $${products[0].valor}).\n\n¿Qué *cantidad* deseas pedir?`);
        session.state = 'AWAITING_QUANTITY';
    } else {
        session.tempProductMatches = products;
        let message = 'Encontré varias coincidencias. Por favor, elige un número de la lista:\n\n';
        products.forEach((p, index) => {
            message += `*${index + 1}.* ${p.nombreProducto} - $${p.valor}\n`;
        });
        twimlResponse.message(message);
        session.state = 'AWAITING_PRODUCT_CHOICE';
    }
}

async function handleProductChoice(choice, session, twimlResponse) {
    const choiceIndex = parseInt(choice, 10) - 1;
    if (session.tempProductMatches && session.tempProductMatches[choiceIndex]) {
        session.tempSelectedItem = session.tempProductMatches[choiceIndex];
        twimlResponse.message(`Has elegido: *${session.tempSelectedItem.nombreProducto}*. \n\nAhora, dime ¿qué *cantidad* deseas?`);
        session.state = 'AWAITING_QUANTITY';
    } else {
        twimlResponse.message('Selección no válida. Por favor, elige un número de la lista que te mostré.');
    }
}

async function handleQuantity(quantityStr, session, twimlResponse) {
    const quantity = parseInt(quantityStr, 10);
    if (isNaN(quantity) || quantity <= 0) {
        twimlResponse.message('Por favor, introduce una cantidad válida (un número mayor que 0).');
        return;
    }
    const product = session.tempSelectedItem;
    const totalItemValue = product.valor * quantity;
    
    session.order.items.push({
        "pedidoid": session.order.pedidoid,
        nombreProducto: product.nombreProducto,
        cantidadProducto: quantity,
        valor_unit: product.valor,
        valor: totalItemValue
    });
    session.order.total += totalItemValue;

    let summary = `*Producto añadido:* ✅\n- ${product.nombreProducto} (x${quantity})\n\n*Total actual del pedido: $${session.order.total}*`;

    if (session.tempProductMatches.length > 1) {
        summary += `\n\n¿Deseas añadir otro producto de esta lista? Responde *SI* o *NO*.`;
        session.state = 'AWAITING_ANOTHER_FROM_LIST';
    } else {
        summary += `\n\nEscribe el nombre de *otro producto* para añadirlo, o escribe *FIN* para completar y guardar tu pedido.`;
        session.state = 'AWAITING_PRODUCT';
    }
    
    twimlResponse.message(summary);
    session.tempSelectedItem = null;
}

async function handleFinalizeOrder(session, twimlResponse) {
    if (session.order.items.length === 0) {
        twimlResponse.message('No has añadido ningún producto. Tu pedido ha sido cancelado. Escribe *Hola* para empezar de nuevo.');
        return;
    }
    
    const success = await appsheet.saveOrder(session.order);

    if (!success) {
        twimlResponse.message('Hubo un problema al registrar tu pedido. Por favor, contacta a un asesor.');
        return;
    }

    // Resumen final CORREGIDO para incluir el celular
    let finalSummary = `*¡Pedido registrado con éxito!* 🎉\n\n*Resumen de tu compra:*\n\n`;
    finalSummary += `*Cliente:* ${session.order.cliente}\n`;
    finalSummary += `*Dirección:* ${session.order.direccion}\n`;
    finalSummary += `*Celular:* ${session.order.celular}\n\n`;
    finalSummary += `*Productos:*\n`;
    session.order.items.forEach(item => {
        finalSummary += `- ${item.nombreProducto} (x${item.cantidadProducto}) = $${item.valor}\n`;
    });
    finalSummary += `\n*TOTAL A PAGAR: $${session.order.total}*\n\n`;
    finalSummary += `Gracias por tu compra. En breve nos pondremos en contacto contigo para coordinar el pago y la entrega.`;
    
    twimlResponse.message(finalSummary);
}

// --- Iniciar el Servidor ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor escuchando en el puerto ${PORT}`);
});
